import { randomUUID } from "node:crypto";
import type { VoiceJournal } from "./journal.js";
import type { RunQuery } from "./service.js";
import { normalizePhone } from "./service.js";
const pi = `pageInfo{hasNextPage endCursor}`;
const clients = `query VoiceIndexClients($after:String){clients(first:50,after:$after){nodes{id phones{number}} ${pi}}}`;
const contacts = `query VoiceIndexContacts($id:EncodedId!,$after:String){client(id:$id){contacts(first:1,after:$after,filter:{includePropertyContacts:true}){nodes{id phones(first:50){nodes{number} ${pi}}} ${pi}}}}`;
const phones = `query VoiceIndexContactPhones($id:EncodedId!,$after:String){clientContact(id:$id){phones(first:50,after:$after){nodes{number} ${pi}}}}`;
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
    if ((await this.run(`query VoiceAccount{account{id}}`, {}, 1)).account?.id !== this.account) throw new Error("Voice Jobber account mismatch");
    const key = `directory:${this.account}`;
    let state = this.journal.checkpoint(key) || { generation: randomUUID(), clients: [], after: null, clientsComplete: false, clientOffset: 0, contactAfter: null };
    this.journal.setCheckpoint(key,state);
    try {
      while (!state.clientsComplete) {
        const c = (await this.run(clients, { after: state.after }, 500)).clients;
        this.validate(c, state.after);
        for (const client of c.nodes) {
          state.clients.push(client.id);
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
          for (const p of contact.phones.nodes) this.add(state.generation, id, p.number);
          let more = contact.phones.pageInfo.hasNextPage, after = contact.phones.pageInfo.endCursor;
          while (more) {
            const rest = (await this.run(phones, { id: contact.id, after }, 300)).clientContact?.phones;
            this.validate(rest, after);
            for (const p of rest.nodes) this.add(state.generation, id, p.number);
            more = rest.pageInfo.hasNextPage; after = rest.pageInfo.endCursor;
          }
        }
        state.contactAfter = c.pageInfo.endCursor;
        if (!c.pageInfo.hasNextPage) { state.clientOffset++; state.contactAfter = null; }
        this.journal.setCheckpoint(key, state);
      }
      this.journal.publishDirectory(this.account, state.generation);
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
