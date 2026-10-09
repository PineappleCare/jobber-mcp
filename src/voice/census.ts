import type { VoiceJournal } from "./journal.js";
import type { RunQuery } from "./service.js";

const pi = `pageInfo{hasNextPage endCursor}`;
const contact = `id name updatedAt emails(first:2){nodes{address} ${pi}} properties(first:2){nodes{id} ${pi}} phones(first:2){nodes{number} ${pi}}`;
// Fetch the common zero/one-contact case with its parent page. Per-client
// contact requests made a 927-client account take thousands of reads per call.
const clients = `query VoiceCensusClients($after:String){clients(first:20,after:$after){nodes{id name companyName updatedAt phones{number} emails{address} properties{id street1 street2 city province postalCode} contacts(first:1,filter:{includePropertyContacts:true}){nodes{${contact}} ${pi}}} ${pi}}}`;
const contacts = `query VoiceCensusContacts($id:EncodedId!,$after:String){client(id:$id){contacts(first:1,after:$after,filter:{includePropertyContacts:true}){nodes{${contact}} ${pi}}}}`;
const phones = `query VoiceCensusPhones($id:EncodedId!,$after:String){clientContact(id:$id){phones(first:50,after:$after){nodes{number} ${pi}}}}`;
const emails = `query VoiceCensusEmails($id:EncodedId!,$after:String){clientContact(id:$id){emails(first:50,after:$after){nodes{address} ${pi}}}}`;
const properties = `query VoiceCensusProperties($id:EncodedId!,$after:String){clientContact(id:$id){properties(first:50,after:$after){nodes{id} ${pi}}}}`;

export class DirectoryIncomplete extends Error {}
export function validateConnection(c:any, after:string|null|undefined):void {
  if(!Array.isArray(c?.nodes) || typeof c.pageInfo?.hasNextPage!=="boolean" || c.pageInfo.hasNextPage && (!c.pageInfo.endCursor || c.pageInfo.endCursor===after))throw new DirectoryIncomplete("Incomplete phone directory");
}

/** Complete, resumable account census; no cached result grants authorization. */
export class VoiceCensus {
  constructor(private journal:VoiceJournal,private run:RunQuery) {}
  async scan(key:string,visit:(client:any)=>Promise<void>|void,guard:()=>void=()=>{}):Promise<void> {
    const saved=this.journal.checkpoint(key);
    const state=saved?.version===1 ? saved:{version:1,started_at:Date.now(),after:null,page:null,offset:0,clients:0,complete:false};
    state.cursors=state.cursors || [];
    while(!state.complete) {
      guard();
      if(!state.page) {
        if(state.cursors.length>=10000)throw new DirectoryIncomplete("Census pagination limit exceeded");
        // Measured against pinned 2025-04-16: requested 885, reserve 900.
        const page=(await this.run(clients,{after:state.after},900)).clients;
        guard();validateConnection(page,state.after);state.page=page;state.offset=0;
        this.journal.setCheckpoint(key,state);
      }
      while(state.offset<state.page.nodes.length) {
        guard();
        const client=state.page.nodes[state.offset];
        const complete=[];let connection=client.contacts;let after:string|null=null;const contactCursors=new Set<string|null>([null]);
        for(;;) {
          validateConnection(connection,after);
          for(const item of connection.nodes) {
            const record={...item};
            for(const [field,query] of [["phones",phones],["emails",emails],["properties",properties]] as const) {
              let c=item[field];validateConnection(c,null);const values=[...c.nodes],cursors=new Set<string>();
              while(c.pageInfo.hasNextPage) {
                guard();const cursor=c.pageInfo.endCursor;
                if(cursors.has(cursor) || cursors.size>=200)throw new DirectoryIncomplete("Contact pagination limit exceeded");
                cursors.add(cursor);
                c=(await this.run(query,{id:item.id,after:cursor},300)).clientContact?.[field];
                validateConnection(c,cursor);values.push(...c.nodes);
              }
              record[field]=values;
            }
            complete.push(record);
          }
          if(!connection.pageInfo.hasNextPage)break;
          guard();after=connection.pageInfo.endCursor;
          if(contactCursors.has(after) || contactCursors.size>=200)throw new DirectoryIncomplete("Contact pagination limit exceeded");
          contactCursors.add(after);
          connection=(await this.run(contacts,{id:client.id,after},300)).client?.contacts;
        }
        guard();await visit({...client,contacts:complete});state.offset++;state.clients++;
        this.journal.setCheckpoint(key,state);
      }
      if(state.page.pageInfo.hasNextPage && state.cursors.includes(state.page.pageInfo.endCursor))throw new DirectoryIncomplete("Census cursor repeated");
      state.cursors.push(state.after);state.complete=!state.page.pageInfo.hasNextPage;state.after=state.page.pageInfo.endCursor;state.page=null;state.offset=0;
      this.journal.setCheckpoint(key,state);
    }
  }
}
