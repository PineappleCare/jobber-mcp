import { randomUUID } from "node:crypto";
import { JobberAuthenticationError } from "../jobber/errors.js";
import type { VoiceJournal } from "./journal.js";
import type { RunQuery } from "./service.js";
import { normalizePhone } from "./service.js";
import { VoiceCensus } from "./census.js";
import { readFailureReason } from "./read-failure.js";
export {DirectoryIncomplete} from "./census.js";
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
    let stage="account";
    try {
      if ((await this.run(`query VoiceAccount{account{id}}`, {}, 1)).account?.id !== this.account) throw new JobberAuthenticationError("Voice Jobber account mismatch");
      const checkpoint=this.journal.checkpoint(key);
      // A rolling upgrade retains the published generation. Its next build uses
      // batched contacts; incomplete old-format generations are never published.
      const state = checkpoint?.version===3 ? checkpoint : {version:3,started_at:Date.now(),generation:randomUUID(),clients:[],clientOffset:0};
      this.journal.setCheckpoint(key,state);
      const censusKey=`${key}:census:${state.generation}`;
      stage="census";
      await new VoiceCensus(this.journal,this.run).scan(censusKey,client=>{
        const {contacts,...basic}=client;
        this.journal.addDirectoryRecord(this.account,state.generation,"client",client.id,client.id,{...basic,observed_at:Date.now()});
        for(const p of client.phones)this.add(state.generation,client.id,p.number);
        for(const contact of contacts) {
          this.journal.addDirectoryRecord(this.account,state.generation,"contact",contact.id,client.id,{...contact,observed_at:Date.now()});
          for(const p of contact.phones)this.add(state.generation,client.id,p.number);
        }
        if(!state.clients.includes(client.id))state.clients.push(client.id);state.clientOffset=state.clients.length;
        this.journal.setCheckpoint(key,state);
      });
      this.journal.publishDirectory(this.account,state.generation);
      this.journal.setCheckpoint(`directory-metadata:${this.account}`,{generation:state.generation,started_at:state.started_at,completed_at:Date.now()});
      this.journal.deleteCheckpoint(key);this.journal.deleteCheckpoint(censusKey);
    } catch(error) {
      this.journal.directoryFailure(this.account,{stage,reason_code:readFailureReason(error)});
      throw error;
    }
  }
  private add(generation:string,id:string,raw:string):void {
    const phone=normalizePhone(raw);
    if(phone)this.journal.addDirectoryPhone(this.account,generation,phone,id);
  }
}
