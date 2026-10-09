import { randomUUID } from "node:crypto";
import type { VoiceJournal } from "./journal.js";
import type { RunQuery } from "./service.js";
import { normalizePhone } from "./service.js";
const pi = `pageInfo{hasNextPage endCursor}`;
const clients = `query VoiceIndexClients($after:String){clients(first:50,after:$after){nodes{id name companyName updatedAt phones{number} emails{address} properties{id street1 street2 city province postalCode}} ${pi}}}`;
const contacts = `query VoiceIndexContacts($id:EncodedId!,$after:String){client(id:$id){contacts(first:1,after:$after,filter:{includePropertyContacts:true}){nodes{id name updatedAt emails(first:50){nodes{address} ${pi}} properties(first:50){nodes{id} ${pi}} phones(first:50){nodes{number} ${pi}}} ${pi}}}}`;
const phones = `query VoiceIndexContactPhones($id:EncodedId!,$after:String){clientContact(id:$id){phones(first:50,after:$after){nodes{number} ${pi}}}}`;
const emails = `query VoiceIndexContactEmails($id:EncodedId!,$after:String){clientContact(id:$id){emails(first:50,after:$after){nodes{address} ${pi}}}}`;
const properties = `query VoiceIndexContactProperties($id:EncodedId!,$after:String){clientContact(id:$id){properties(first:50,after:$after){nodes{id} ${pi}}}}`;
export class DirectoryIncomplete extends Error {}
/** Discovery only. Every candidate must pass fresh authorization before disclosure. */
export class VoiceDirectory {
  private refreshing?: Promise<void>;
  constructor(private journal: VoiceJournal, private run: RunQuery, private account: string) {}
  status(): Record<string, unknown> { return this.journal.directoryStatus(this.account); }
  candidates(number: string): string[] | undefined { return this.journal.directoryCandidates(this.account, number); }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.build().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async build(): Promise<void> {
    const key = `directory:${this.account}`;
    try {
      if ((await this.run(`query VoiceAccount{account{id}}`, {}, 1)).account?.id !== this.account) throw new Error("Voice Jobber account mismatch");
      const checkpoint=this.journal.checkpoint(key);
      // Old phone-only builds cannot be published as a complete metadata census.
      // Keep their previously published index available while a new build runs.
      const state = checkpoint?.version===2 ? checkpoint : { version:2,started_at:Date.now(),generation: randomUUID(), clients: [], after: null, clientsComplete: false, clientOffset: 0, contactAfter: null };
      this.journal.setCheckpoint(key,state);
      while (!state.clientsComplete) {
        const c = (await this.run(clients, { after: state.after }, 500)).clients;
        this.validate(c, state.after);
        for (const client of c.nodes) {
          state.clients.push(client.id);
          this.journal.addDirectoryRecord(this.account,state.generation,"client",client.id,client.id,{...client,observed_at:Date.now()});
          for (const p of client.phones) this.add(state.generation, client.id, p.number);
        }
        state.after = c.pageInfo.endCursor; state.clientsComplete = !c.pageInfo.hasNextPage;
        this.journal.setCheckpoint(key, state);
      }
      while (state.clientOffset < state.clients.length) {
        const id = state.clients[state.clientOffset];
        const c = (await this.run(contacts, { id, after: state.contactAfter }, 800)).client?.contacts;
        this.validate(c, state.contactAfter);
        for (const contact of c.nodes) {
          this.validate(contact.phones, null);
          const metadata={...contact,observed_at:Date.now()};
          for(const [field,query] of [["emails",emails],["properties",properties]] as const) {
            this.validate(contact[field],null);
            const values=[...contact[field].nodes];let connection=contact[field];
            while(connection.pageInfo.hasNextPage){const after=connection.pageInfo.endCursor;connection=(await this.run(query,{id:contact.id,after},300)).clientContact?.[field];this.validate(connection,after);values.push(...connection.nodes);}
            metadata[field]=values;
          }
          for (const p of contact.phones.nodes) this.add(state.generation, id, p.number);
          const phoneValues=[...contact.phones.nodes];
          let more = contact.phones.pageInfo.hasNextPage, after = contact.phones.pageInfo.endCursor;
          while (more) {
            const rest = (await this.run(phones, { id: contact.id, after }, 300)).clientContact?.phones;
            this.validate(rest, after);
            phoneValues.push(...rest.nodes);
            for (const p of rest.nodes) this.add(state.generation, id, p.number);
            more = rest.pageInfo.hasNextPage; after = rest.pageInfo.endCursor;
          }
          metadata.phones=phoneValues;this.journal.addDirectoryRecord(this.account,state.generation,"contact",contact.id,id,metadata);
        }
        state.contactAfter = c.pageInfo.endCursor;
        if (!c.pageInfo.hasNextPage) { state.clientOffset++; state.contactAfter = null; }
        this.journal.setCheckpoint(key, state);
      }
      this.journal.publishDirectory(this.account, state.generation);
      this.journal.setCheckpoint(`directory-metadata:${this.account}`,{generation:state.generation,started_at:state.started_at,completed_at:Date.now()});
      this.journal.deleteCheckpoint(key);
    } catch (error) {
      this.journal.directoryFailure(this.account);
      throw error;
    }
  }
  private add(generation: string, id: string, raw: string): void {
    const phone = normalizePhone(raw);
    if (phone) this.journal.addDirectoryPhone(this.account, generation, phone, id);
  }
  private validate(c: any, after: string | null): void {
    if (!Array.isArray(c?.nodes) || typeof c.pageInfo?.hasNextPage !== "boolean" || c.pageInfo.hasNextPage && (!c.pageInfo.endCursor || c.pageInfo.endCursor === after)) throw new DirectoryIncomplete("Incomplete phone directory");
  }
}
