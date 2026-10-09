import { BudgetUnavailableError, RequestRateLimitError } from "../jobber/cost-governor.js";
import { JobberPermissionError, JobberAuthenticationError, hasMutationExecutionErrors } from "../jobber/client.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { VoiceDirectory, DirectoryIncomplete } from "./directory.js";
import { fingerprint } from "./journal.js";
import { z } from "zod";
import { addressMatches, normalizedText, normalizedStreet, WorkflowRequired, KeyedGate } from "./workflow.js";
import type { VoiceJournal, VoiceResult } from "./journal.js";
import { appendAuditLog } from "../utils/auditLog.js";

export type RunQuery = (query: string, variables?: Record<string, unknown>, maxCost?: number) => Promise<any>;
const text = z.string().trim().max(10000);
export const voiceInput = z.object({
  action: z.enum(["resolve", "status", "prepare", "preflight", "submit", "message", "operation_status", "end_call"]),
  call_id: z.string().min(1).max(200), caller_number: z.string().max(80),
  operation_id: z.string().uuid().optional(), record_type: z.enum(["client", "request", "job"]).optional(), record_id: z.string().max(200).optional(),
  confirmed: z.boolean().default(false),
  workflow_version: z.literal(2).optional(), preflight_id:z.string().uuid().optional(), supersedes_operation_id:z.string().uuid().optional(),
  intake: z.object({
    name: text.default(""), callback_number: text.default(""), company: text.default(""), email: z.union([z.literal(""), z.string().email()]).default(""),
    description: text.default(""), service: text.default(""), street1: text.default(""), street2: text.default(""), city: text.default(""),
    province: text.default(""), postal_code: text.default(""), access: text.default(""), urgency: text.default(""), timing: text.default(""),
    notes: text.default(""), assessment: z.boolean().default(false), property_id: z.string().max(200).optional(), client_id: z.string().max(200).optional(),
  }).strict().optional(), message: text.optional(),
}).strict();
export type VoiceInput = z.infer<typeof voiceInput>;

// Full numbers only. The voice model's callback preference is never identity.
export function normalizePhone(value: string): string | null {
  if (!/^\+?[\d\s().-]+$/.test(value.trim())) return null;
  const digits = value.replace(/\D/g, "");
  if (!value.trim().startsWith("+") && digits.length === 10) return `+1${digits}`;
  if ((!value.trim().startsWith("+") && digits.length === 11 && digits.startsWith("1")) || (value.trim().startsWith("+") && /^[1-9]\d{7,14}$/.test(digits))) return `+${digits}`;
  return null;
}
const pageInfo = `pageInfo{hasNextPage endCursor}`;
const properties = `properties{id name street1 street2 city province postalCode country jobberWebUri}`;
const clientBasic = `id name firstName lastName companyName jobberWebUri phones{number} emails{address} ${properties}`;
const clientsQuery = `query VoiceClients($after:String){clients(first:10,after:$after){nodes{${clientBasic}} ${pageInfo}}}`;
const clientQuery = `query VoiceClient($id:EncodedId!){client(id:$id){${clientBasic}}}`;
const contactsQuery = `query VoiceContacts($id:EncodedId!,$after:String){client(id:$id){contacts(first:1,after:$after,filter:{includePropertyContacts:true}){nodes{id properties(first:50){nodes{id} ${pageInfo}} phones(first:50){nodes{number} ${pageInfo}}} ${pageInfo}}}}`;
const contactQuery = `query VoiceContact($id:EncodedId!,$contactAfter:String,$after:String){client(id:$id){contacts(first:1,after:$contactAfter,filter:{includePropertyContacts:true}){nodes{id phones(first:50,after:$after){nodes{number} ${pageInfo}}}}}}`;
const contactPropertiesQuery = `query VoiceContactProperties($id:EncodedId!,$contactAfter:String,$after:String){client(id:$id){contacts(first:1,after:$contactAfter,filter:{includePropertyContacts:true}){nodes{id properties(first:50,after:$after){nodes{id} ${pageInfo}}}}}}`;
const contactEmailsQuery = `query VoiceContactEmails($id:EncodedId!,$after:String){client(id:$id){contacts(first:1,after:$after,filter:{includePropertyContacts:true}){nodes{id name emails(first:50){nodes{address} ${pageInfo}}} ${pageInfo}}}}`;
const moreContactEmailsQuery = `query VoiceMoreContactEmails($id:EncodedId!,$contactAfter:String,$after:String){client(id:$id){contacts(first:1,after:$contactAfter,filter:{includePropertyContacts:true}){nodes{id emails(first:50,after:$after){nodes{address} ${pageInfo}}}}}}`;
const requestFields = `id title requestStatus jobberWebUri client{id} property{id} assessment{id instructions startAt endAt assignedUsers(first:20){nodes{id} ${pageInfo}}}`;
const requestQuery = `query VoiceRequest($id:EncodedId!){request(id:$id){${requestFields}}}`;
const jobFields = `id title jobStatus jobberWebUri client{id} property{id}`;
const jobQuery = `query VoiceJob($id:EncodedId!){job(id:$id){${jobFields}}}`;
const visitsQuery = `query VoiceVisits($id:EncodedId!,$after:String){job(id:$id){visits(first:50,after:$after){nodes{id startAt endAt allDay arrivalWindow{duration startAt endAt}} ${pageInfo}}}}`;
const clientRequests = `query VoiceClientRequests($id:EncodedId!,$after:String){client(id:$id){requests(first:50,after:$after){nodes{${requestFields}} ${pageInfo}}}}`;
const clientJobs = `query VoiceClientJobs($id:EncodedId!,$after:String){client(id:$id){jobs(first:50,after:$after){nodes{${jobFields}} ${pageInfo}}}}`;
const newClient = `mutation VoiceCreateClient($input:ClientCreateInput!){clientCreate(input:$input){client{${clientBasic}} userErrors{message path}}}`;
const newProperty = `mutation VoiceCreateProperty($id:EncodedId!,$input:PropertyCreateInput!){propertyCreate(clientId:$id,input:$input){properties{id name street1 street2 city province postalCode country jobberWebUri} userErrors{message path}}}`;
const newRequest = `mutation VoiceCreateRequest($input:RequestCreateInput!){requestCreate(input:$input){request{${requestFields}} userErrors{message path}}}`;
const newAssessment = `mutation VoiceCreateAssessment($id:EncodedId!,$input:AssessmentCreateInput!){assessmentCreate(requestId:$id,input:$input){assessment{id instructions startAt endAt request{id} assignedUsers(first:20){nodes{id} ${pageInfo}}} userErrors{message path}}}`;
const notes = {
  client: { query: `query VoiceClientNotes($id:EncodedId!,$after:String){client(id:$id){notes(first:50,after:$after){nodes{id message} ${pageInfo}}}}`, mutation: `mutation VoiceClientNote($id:EncodedId!,$input:ClientCreateNoteInput!){clientCreateNote(clientId:$id,input:$input){clientNote{id message} userErrors{message path}}}`, payload: "clientCreateNote", field: "clientNote" },
  request: { query: `query VoiceRequestNotes($id:EncodedId!,$after:String){request(id:$id){notes(first:50,after:$after){nodes{... on NoteInterface{id message}} ${pageInfo}}}}`, mutation: `mutation VoiceRequestNote($id:EncodedId!,$input:RequestCreateNoteInput!){requestCreateNote(requestId:$id,input:$input){requestNote{id message} userErrors{message path}}}`, payload: "requestCreateNote", field: "requestNote" },
  job: { query: `query VoiceJobNotes($id:EncodedId!,$after:String){job(id:$id){notes(first:50,after:$after){nodes{... on NoteInterface{id message}} ${pageInfo}}}}`, mutation: `mutation VoiceJobNote($id:EncodedId!,$input:JobCreateNoteInput!){jobCreateNote(jobId:$id,input:$input){jobNote{id message} userErrors{message path}}}`, payload: "jobCreateNote", field: "jobNote" },
};
class Uncertain extends Error {}
class Permanent extends Error {}
class ValidationRejected extends Permanent {
  constructor(readonly step: string, readonly errors: unknown[]) { super(`Jobber rejected the ${step} input`); }
}
function knownLocation(i: NonNullable<VoiceInput["intake"]>): boolean { return !!(i.street1 && i.city && /\d/.test(i.street1)); }
const sameAddress=addressMatches;
type Match = { client: any; propertyIds: Set<string> | null };
function url(record: any): string | undefined {
  try { const u = new URL(record.jobberWebUri); return u.protocol === "https:" && (u.hostname === "secure.getjobber.com" || u.hostname.endsWith(".getjobber.com")) ? u.href : undefined; } catch { return undefined; }
}
function ref(record: any): VoiceResult { return { id: record.id, ...(url(record) ? { url: url(record) } : {}) }; }

export class VoiceService {
  private running = new Set<string>();
  private gates = new KeyedGate();
  private jobs = new Map<string, Promise<VoiceResult>>();
  private readChecks = new Map<string, { work: Promise<VoiceResult>; expires?: number; timer?: ReturnType<typeof setTimeout> }>();
  private lookupContext = new AsyncLocalStorage<string>();
  readonly directory: VoiceDirectory;
  constructor(private journal: VoiceJournal, private run: RunQuery, private accountId: string) { this.directory=new VoiceDirectory(journal,run,accountId); }
  directoryHealth(): Record<string,unknown> {return this.directory.status();}
  inputNeverJournaled(id: unknown): boolean {return typeof id !== "string" || !this.journal.hasOperation(id);}
  async tick():Promise<void> { for(const op of this.journal.pending()) if(!this.jobs.has(op.id))void this.launch(voiceInput.parse(this.journal.input(op.id,op.call))); }
  /** Private HTTP dispatch is always quick; the journal owns unfinished work. */
  async dispatch(raw:unknown):Promise<VoiceResult> {
    const input=voiceInput.parse(raw);
    if(input.action==="end_call") {if(!this.journal.checkpoint(`ended-call:${input.call_id}`))this.journal.setCheckpoint(`ended-call:${input.call_id}`,{ended_at:Date.now()});return {outcome:"completed",records:{}};}
    if(input.action==="prepare") return this.execute(input);
    if(input.action==="operation_status") {
      if(!input.operation_id)throw new Permanent("operation_id required");
      let result:VoiceResult;try{result=this.journal.get(input.operation_id,input.call_id);}catch{return {outcome:"not_found",operation_id:input.operation_id};}
      const original=voiceInput.parse(this.journal.input(input.operation_id,input.call_id));
      if(result.outcome==="completed" && ["resolve","status"].includes(original.action)) {
        return this.deliverRead(original, result);
      }
      if(["pending","uncertain"].includes(result.outcome) && (!result.retry_at || result.retry_at<=Date.now())) this.launch(voiceInput.parse(this.journal.input(input.operation_id,input.call_id)));
      return result;
    }
    if(!input.operation_id) input.operation_id=randomUUID();
    const saved=this.journal.start(input.operation_id,input.call_id,input);
    if(!["pending","uncertain"].includes(saved.outcome))return saved.outcome === "completed" && ["resolve","status"].includes(input.action) ? this.deliverRead(input,saved) : saved;
    if(saved.retry_at && saved.retry_at>Date.now())return saved;
    const work=this.launch(input);
    let timer:ReturnType<typeof setTimeout>;
    const timeout=new Promise<VoiceResult>(resolve=>{timer=setTimeout(()=>{const result=this.journal.get(input.operation_id!,input.call_id);resolve({...result,...(result.outcome === "pending" && !result.retry_at ? {retry_at:Date.now()+1000}: {})});},2000);});
    try{return await Promise.race([work,timeout]);}finally{clearTimeout(timer!);}
  }
  // Completed discovery stays durable. Each disclosure gets a fresh authorization
  // check, without restarting directory/job-list scans. Slow checks have a single
  // in-flight task and a one-use, two-second handoff to the next poll.
  private async deliverRead(input: VoiceInput, result: VoiceResult): Promise<VoiceResult> {
    const id=input.operation_id!;
    let check=this.readChecks.get(id);
    if(check?.expires && check.expires <= Date.now()) {clearTimeout(check.timer);this.readChecks.delete(id);check=undefined;}
    if(!check) {
      const entry: { work: Promise<VoiceResult>; expires?: number; timer?: ReturnType<typeof setTimeout> }={work:Promise.resolve({})};
      this.readChecks.set(id,entry);
      entry.work=this.reauthorizeRead(input,result).catch(error=>({operation_id:id,outcome:error instanceof Permanent || error instanceof JobberPermissionError || error instanceof JobberAuthenticationError ? "failed":"pending",records:{},reason_code:error instanceof Permanent ? "authorization_changed":"lookup_unavailable",retry_at:Date.now()+1000})).then(value=>{
        entry.expires=Date.now()+2000;
        entry.timer=setTimeout(()=>{if(this.readChecks.get(id)===entry)this.readChecks.delete(id);},2000);entry.timer.unref();
        return value;
      });
      check=entry;
    }
    let timer:ReturnType<typeof setTimeout>;
    const pending={operation_id:id,outcome:"pending",records:{},reason_code:"authorization_refresh",retry_at:Date.now()+1000};
    try {
      const value=await Promise.race([check.work,new Promise<VoiceResult>(resolve=>{timer=setTimeout(()=>resolve(pending),2000);})]);
      if(value!==pending) {clearTimeout(check.timer);if(this.readChecks.get(id)===check)this.readChecks.delete(id);}
      return value;
    } finally {clearTimeout(timer!);}
  }
  private async reauthorizeRead(input: VoiceInput, result: VoiceResult): Promise<VoiceResult> {
    if((await this.run(`query VoiceAccount{account{id}}`,{},1)).account?.id!==this.accountId)throw new Permanent("Voice Jobber account mismatch");
    if(input.action === "status") {
      const target=await this.target(input);
      const record=await this.publicStatus(input.record_type!,target.record);
      await this.target(input);
      return {...result,record};
    }
    const records=[];
    for(const prior of result.records) {
      await this.fresh(normalizePhone(input.caller_number),prior.id);
      const requests:any[]=[],jobs:any[]=[];
      for(const [type,list] of [["request",prior.requests],["job",prior.jobs]] as const) {
        for(const selected of list) {
          const record=(await this.run(type === "job" ? jobQuery:requestQuery,{id:selected.id},1000))[type];
          if(record?.client?.id===prior.id)(type === "job" ? jobs:requests).push(record);
        }
      }
      const current=await this.fresh(normalizePhone(input.caller_number),prior.id);
      records.push({record_type:"client",...ref(current.client),name:current.client.name,selectable:!current.propertyIds,
        properties:current.client.properties.filter((p:any)=>this.allowed(current,p.id)).map((p:any)=>({id:p.id,address:[p.street1,p.street2,p.city].filter(Boolean).join(", ")})),
        requests:requests.filter(r=>this.allowed(current,r.property?.id)).map(r=>({...ref(r),title:r.title})),
        jobs:jobs.filter(r=>this.allowed(current,r.property?.id)).map(r=>({...ref(r),title:r.title}))});
    }
    return {...result,records};
  }
  private launch(input:VoiceInput):Promise<VoiceResult> {
    const id=input.operation_id!;
    const old=this.jobs.get(id);if(old)return old;
    if(!this.journal.claim(id))return Promise.resolve(this.journal.get(id,input.call_id));
    const heartbeat=setInterval(()=>this.journal.renew(id),30000);heartbeat.unref();
    const task=this.lookupContext.run(id,async()=>{
      let result:VoiceResult;
      try {
        const prior=this.journal.get(id,input.call_id);
        result=prior.outcome==="uncertain" ? await this.execute({action:"operation_status",operation_id:id,call_id:input.call_id,caller_number:input.caller_number}) : await this.execute(input);
      }catch(error){
        const permanent=error instanceof Permanent || error instanceof WorkflowRequired || error instanceof JobberPermissionError || error instanceof JobberAuthenticationError;
        result=this.journal.get(id,input.call_id);result.outcome=permanent ? "failed":"pending";
        result.reason_code=error instanceof WorkflowRequired ? error.code:permanent ? "validation_or_authorization":"lookup_unavailable";
        if(error instanceof WorkflowRequired){result.next_action=error.nextAction;result.choices=error.choices;}
        result.retry_at=this.journal.retryAt(id);
      }
      result.operation_id=id; this.journal.save(id,result);if(result.outcome==="completed")this.journal.clearScan(id);return result;
    }).finally(()=>{clearInterval(heartbeat);this.journal.release(id);this.jobs.delete(id);});
    this.jobs.set(id,task);return task;
  }
  private async scan(query:string,variables:Record<string,unknown>):Promise<any> {
    const id=this.lookupContext.getStore();
    if(id) {const original=voiceInput.parse(this.journal.input(id,this.journal.operationCall(id)));if(["resolve","preflight"].includes(original.action) && this.journal.checkpoint(`ended-call:${original.call_id}`))throw new WorkflowRequired("call_ended","none");}
    const memo=/query Voice(?:Clients|Contacts|ContactEmails)\(/.test(query);const key=id && memo ? `scan:${id}:${fingerprint({query,variables})}`:undefined;
    const saved=key && this.journal.checkpoint(key);if(saved?.observed_at && Date.now()-saved.observed_at<60000)return saved.data;
    const result=await this.run(query,variables,this.cost(query));
    if(key) {
      const c=result.clients || result.client?.contacts;
      if(!Array.isArray(c?.nodes) || typeof c.pageInfo?.hasNextPage!=="boolean" || c.pageInfo.hasNextPage && (!c.pageInfo.endCursor || c.pageInfo.endCursor===variables.after))throw new DirectoryIncomplete("Incomplete Jobber lookup");
      this.journal.setCheckpoint(key,{observed_at:Date.now(),data:result});
    }
    return result;
  }
  private cost(query:string):number {
    if(query.includes("VoiceClients("))return 2500;
    if(query.includes("VoiceClientRequests"))return 2500;
    if(query.includes("VoiceContacts") || query.includes("VoiceContactEmails"))return 800;
    if(query.includes("VoiceClient("))return 1500;
    return 500;
  }
  health(): Record<string, number> { return this.journal.counts(); }
  private async pages(query: string, variables: Record<string, unknown>, select: (data: any) => any): Promise<any[]> {
    const result: any[] = []; let after: string | undefined;
    for (let page = 0; page < (query===clientsQuery ? 10000:200); page++) {
      const connection = select(await this.scan(query, { ...variables, after }));
      if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new Error("Incomplete Jobber lookup");
      result.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return result;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) throw new Error("Incomplete Jobber lookup");
      after = connection.pageInfo.endCursor;
    }
    throw new Permanent("Lookup exceeds bounded scan; staff review required");
  }
  private async clients(): Promise<any[]> { return this.pages(clientsQuery, {}, d => d.clients); }
  private async match(client: any, number: string, fresh=false): Promise<Match | null> {
    if (client.phones.some((p: any) => normalizePhone(p.number) === number)) return { client, propertyIds: null };
    const allowed = new Set<string>(); let matched = false, unrestricted = false;
    let after: string | undefined;
    for (let page = 0; page < 200; page++) {
      const connection = (await (fresh ? this.run(contactsQuery,{id:client.id,after},800):this.scan(contactsQuery, { id: client.id, after }))).client?.contacts;
      if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new Error("Incomplete contact lookup");
      for (const contact of connection.nodes) {
        const variables = { id: client.id, contactAfter: after };
        const select = (d: any) => d.client?.contacts.nodes.find((c: any) => c.id === contact.id);
        if (!Array.isArray(contact.phones?.nodes) || typeof contact.phones?.pageInfo?.hasNextPage !== "boolean" || !Array.isArray(contact.properties?.nodes) || typeof contact.properties?.pageInfo?.hasNextPage !== "boolean") throw new Error("Incomplete contact lookup");
        const phones = contact.phones.pageInfo.hasNextPage ? await this.pages(contactQuery, variables, d => select(d)?.phones) : contact.phones.nodes;
        if (!phones.some((p: any) => normalizePhone(p.number) === number)) continue;
        matched = true;
        const ps = contact.properties.pageInfo.hasNextPage ? await this.pages(contactPropertiesQuery, variables, d => select(d)?.properties) : contact.properties.nodes;
        if (!ps.length) unrestricted = true;
        for (const p of ps) allowed.add(p.id);
      }
      if (!connection.pageInfo.hasNextPage) break;
      if (page === 199 || !connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) throw new Error("Incomplete contact lookup");
      after = connection.pageInfo.endCursor;
    }
    // A contact without property associations is client-wide; explicit associations narrow access.
    return matched ? { client, propertyIds: unrestricted ? null : allowed } : null;
  }
  private async duplicateContact(clientId: string, name: string, email: string): Promise<boolean> {
    let after: string | undefined;
    let duplicate = false;
    for (let page = 0; page < 200; page++) {
      const connection = (await this.scan(contactEmailsQuery, { id: clientId, after })).client?.contacts;
      if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new Error("Incomplete duplicate lookup");
      for (const contact of connection.nodes) {
        const emails = await this.pages(moreContactEmailsQuery, { id: clientId, contactAfter: after }, d => d.client?.contacts?.nodes.find((c: any) => c.id === contact.id)?.emails);
        if (normalizedText(contact.name) === normalizedText(name) || email && emails.some((e: any) => e.address.toLowerCase() === email.toLowerCase())) duplicate = true;
      }
      if (!connection.pageInfo.hasNextPage) return duplicate;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) throw new Error("Incomplete duplicate lookup");
      after = connection.pageInfo.endCursor;
    }
    throw new Error("Incomplete duplicate lookup");
  }
  private async matches(number: string | null, complete=false): Promise<Match[]> {
    if (!number) return [];
    const matches: Match[] = [];
    const candidates=!complete && this.lookupContext.getStore() ? this.directory.candidates(number):undefined;
    if(!complete && this.lookupContext.getStore() && candidates===undefined) {await this.directory.refresh();}
    const ids=!complete && this.lookupContext.getStore() ? this.directory.candidates(number):undefined;
    if(ids?.length) {for(const id of ids){const c=(await this.run(clientQuery,{id},1500)).client;if(c){const m=await this.lookupContext.run("",()=>this.match(c,number,true));if(m)matches.push(m);}}}
    else {for (const c of await this.clients()) { const m = await this.match(c, number); if (m) matches.push(m); }}
    return matches;
  }
  private async destination(input:VoiceInput):Promise<{client?:any;property?:any;match?:Match}> {
    const i=input.intake;if(!i)throw new WorkflowRequired("missing_intake","collect_details");
    const number=normalizePhone(input.caller_number);
    // Discovery through an index never proves uniqueness. Only explicit IDs may
    // bypass the complete scan, and they still require current phone ownership.
    let matched:Match[];
    if(i.client_id)matched=[await this.fresh(number,i.client_id)];
    else matched=await this.matches(number,true);
    if(!matched.length) {
      if(i.property_id)throw new WorkflowRequired("unauthorized_destination","select_property");
      if(!knownLocation(i))throw new WorkflowRequired("missing_location","collect_location");
      return {};
    }
    const identity=(m:Match)=>[m.client.name,m.client.companyName].some(n=>normalizedText(n)===normalizedText(i.company || i.name));
    const atAddress=matched.filter(m=>m.client.properties.some((p:any)=>sameAddress(p,i) && this.allowed(m,p.id)) && identity(m));
    const byName=matched.filter(identity);
    const selected=i.client_id ? matched[0]:atAddress.length===1 ? atAddress[0]:byName.length===1 ? byName[0]:undefined;
    const choices=matched.map(m=>({id:m.client.id,name:m.client.name,properties:m.client.properties.filter((p:any)=>this.allowed(m,p.id)).map((p:any)=>({id:p.id,address:[p.street1,p.street2,p.city].filter(Boolean).join(", ")}))}));
    if(!selected) {
      const relevant=atAddress.length>1 ? atAddress:byName.length>1 ? byName:matched;
      const description=(m:Match)=>fingerprint({name:normalizedText(m.client.name),company:normalizedText(m.client.companyName),properties:m.client.properties.filter((p:any)=>this.allowed(m,p.id)).map((p:any)=>[normalizedStreet(p.street1),normalizedText(p.street2),normalizedText(p.city)]).sort()});
      if(relevant.length>1 && relevant.every(m=>description(m)===description(relevant[0])))throw new WorkflowRequired("indistinguishable_clients","staff_review");
      throw new WorkflowRequired("client_selection_required","select_client",choices);
    }
    const current=await this.fresh(number,selected.client.id), client=current.client;
    const candidates=client.properties.filter((p:any)=>i.property_id ? p.id===i.property_id:sameAddress(p,i));
    if(candidates.length>1)throw new WorkflowRequired("property_selection_required","select_property",choices.filter(c=>c.id===client.id));
    const property=candidates[0];
    if(i.property_id && !property || property && !this.allowed(current,property.id) || current.propertyIds && !property)throw new WorkflowRequired("unauthorized_property","select_property");
    if(i.property_id && i.street1 && i.city && !sameAddress(property,i))throw new WorkflowRequired("property_address_changed","confirm_destination");
    const possible=client.properties.filter((p:any)=>this.allowed(current,p.id) && normalizedStreet(p.street1)===normalizedStreet(i.street1) && normalizedText(p.city)===normalizedText(i.city));
    if(!property && possible.length)throw new WorkflowRequired("possible_property_duplicate","select_property",choices.filter(c=>c.id===client.id));
    if(!property && !knownLocation(i))throw new WorkflowRequired("missing_location","collect_location");
    return {client,property,match:current};
  }
  private async preflight(input:VoiceInput):Promise<VoiceResult> {
    const i=input.intake;
    const missing=[!i?.name && "name",!normalizePhone(i?.callback_number || "") && "callback_number",!i?.description && "description",!i?.service && "service"].filter(Boolean);
    const base={outcome:"completed",preflight_id:input.operation_id,intake_fingerprint:fingerprint(i),missing_fields:missing,records:{}};
    if(missing.length)return {...base,preflight_state:"missing_details",next_action:"collect_details"};
    try {
      const selected=await this.destination(input);
      if(!selected.client)await this.checkDuplicates(input);
      return {...base,preflight_state:"ready",destination:{...(selected.client ? {client_id:selected.client.id,name:selected.client.name}: {new_client:true,name:i!.company || i!.name}),...(selected.property ? {property_id:selected.property.id,address:[selected.property.street1,selected.property.street2,selected.property.city].filter(Boolean).join(", ")}:{new_property:true,address:[i!.street1,i!.street2,i!.city].filter(Boolean).join(", ")})},next_action:"read_back_and_confirm"};
    }catch(error){
      if(!(error instanceof WorkflowRequired))throw error;
      return {...base,preflight_state:error.nextAction==="staff_review" ? "staff_review":"selection_required",reason_code:error.code,next_action:error.nextAction,choices:error.choices};
    }
  }
  private async checkDuplicates(input:VoiceInput):Promise<void> {
    const i=input.intake!;
    const key=`duplicate-work:${input.operation_id}`;
    // Two resumable discovery passes include linked/property contacts separately;
    // no assumption that editing a contact bumps its parent client's timestamp.
    let state=this.journal.checkpoint(key);
    if(state?.pass>=2)state=undefined;
    state=state || {generation:randomUUID(),active_ms:0,pass:0,after:null,offset:0,clients:[],complete:false};
    const started=Date.now();
    try {
      if(state.active_ms>=600000)throw new WorkflowRequired("duplicate_check_incomplete","staff_review");
      while(state.pass<2) {
        while(!state.complete) {
          const c=(await this.run(clientsQuery,{after:state.after},this.cost(clientsQuery))).clients;
          if(!Array.isArray(c?.nodes) || typeof c.pageInfo?.hasNextPage!=="boolean" || c.pageInfo.hasNextPage && (!c.pageInfo.endCursor || c.pageInfo.endCursor===state.after))throw new DirectoryIncomplete();
          state.clients.push(...c.nodes.map((v:any)=>v.id));state.after=c.pageInfo.endCursor;state.complete=!c.pageInfo.hasNextPage;
          this.journal.setCheckpoint(key,state);
        }
        while(state.offset<state.clients.length) {
          const c=(await this.run(clientQuery,{id:state.clients[state.offset]},this.cost(clientQuery))).client;
          if(!c)throw new DirectoryIncomplete();
          const duplicate=c.properties.some((p:any)=>sameAddress(p,i)) || await this.lookupContext.run("",()=>this.duplicateContact(c.id,i.name,i.email)) || await this.match(c,normalizePhone(i.callback_number)!,true) || normalizedText(c.name)===normalizedText(i.company || i.name) || !!i.email && c.emails.some((e:any)=>normalizedText(e.address)===normalizedText(i.email));
          if(duplicate)throw new WorkflowRequired("potential_duplicate","staff_review");
          state.offset++;this.journal.setCheckpoint(key,state);
          if(state.active_ms+Date.now()-started>=600000)throw new WorkflowRequired("duplicate_check_incomplete","staff_review");
        }
        state.pass++;state.clients=[];state.after=null;state.offset=0;state.complete=false;
        this.journal.setCheckpoint(key,state);
      }
    }finally{state.active_ms+=Date.now()-started;this.journal.setCheckpoint(key,state);}
  }
  private async fresh(number: string | null, clientId: string): Promise<Match> {
    if (!number) throw new Permanent("Caller phone is not matched");
    const c = (await this.run(clientQuery, { id: clientId }, 1500)).client;
    const m = c && await this.lookupContext.run("",()=>this.match(c, number,true));
    if (!m) throw new Permanent("Caller phone is not matched");
    return m;
  }
  private allowed(m: Match, propertyId?: string): boolean { return !m.propertyIds || (!!propertyId && m.propertyIds.has(propertyId)); }
  private async target(input: VoiceInput): Promise<{ record: any; match: Match }> {
    if (!input.record_type || !input.record_id) throw new Permanent("Select an authorized record first");
    const type = input.record_type;
    const record = (await this.run(type === "job" ? jobQuery : type === "request" ? requestQuery : clientQuery, { id: input.record_id }, 1000))[type];
    if (!record) throw new Permanent("Record is not accessible");
    const m = await this.fresh(normalizePhone(input.caller_number), type === "client" ? record.id : record.client.id);
    if (type === "client" && m.propertyIds || type !== "client" && !this.allowed(m, record.property?.id)) throw new Permanent("Record is not accessible");
    return { record, match: m };
  }
  private async publicStatus(type: string, r: any): Promise<VoiceResult> {
    const appointments = type === "job" ? await this.pages(visitsQuery, { id: r.id }, d => d.job?.visits) : r.assessment ? [r.assessment] : [];
    return { record_type: type, ...ref(r), title: type === "client" ? r.name : r.title?.replace(/ \[voice [0-9a-f-]+\]$/, ""), status: r.jobStatus ?? r.requestStatus,
      timezone: "America/Toronto", appointments: appointments.map((a: any) => ({ mode: !a.startAt && !a.endAt ? "unscheduled" : a.allDay ? "anytime" : "timed", start_at: a.startAt, end_at: a.endAt, arrival_window: a.arrivalWindow })) };
  }
  async execute(raw: unknown): Promise<VoiceResult> {
    const input = voiceInput.parse(raw);
    if(["resolve","preflight"].includes(input.action) && this.journal.checkpoint(`ended-call:${input.call_id}`))throw new WorkflowRequired("call_ended","none");
    if(input.action==="status" && Date.now()-(this.journal.checkpoint(`ended-call:${input.call_id}`)?.ended_at || Date.now())>30000)throw new WorkflowRequired("call_ended","none");
    const account = (await this.run(`query VoiceAccount{account{id}}`, {}, 1)).account;
    if (!this.accountId || account?.id !== this.accountId) throw new Permanent("Voice Jobber account mismatch");
    if (input.action === "operation_status") {
      if (!input.operation_id) throw new Error("operation_id is required");
      let result: VoiceResult;
      try { result = this.journal.get(input.operation_id, input.call_id); } catch { return { outcome: "not_found", operation_id: input.operation_id }; }
      if (result.outcome === "pending" && !this.running.has(input.operation_id)) return this.execute(this.journal.input(input.operation_id,input.call_id));
      if (result.outcome === "uncertain" && !this.running.has(input.operation_id)) {
        // Recovery shares the submission gate. A second poll returns the current
        // journal snapshot rather than writing a stale result over this recovery.
        const original = voiceInput.parse(this.journal.input(input.operation_id,input.call_id));
        this.running.add(input.operation_id);
        try { result = await this.reconcile(original,result); }
        finally { this.running.delete(input.operation_id); }
        if (result.outcome === "pending") return this.execute(original);
      }
      return result;
    }
    if (input.action === "resolve") {
      const number=normalizePhone(input.caller_number);
      const indexed=!!number && !!this.directory.candidates(number)?.length;
      const matched = await this.matches(number);
      const records:any[]=[];
      const progress=()=>({outcome:"pending",phone_match:matched.length ? "matched":"unmatched",discovery_complete:!indexed,ambiguous:matched.length>1,records,history_complete:false});
      // Publish all authorized basic profiles before querying any job history.
      for(const m of matched) {
        const current=await this.fresh(number,m.client.id);
        records.push({record_type:"client",...ref(current.client),name:current.client.name,selectable:!current.propertyIds,
          properties:current.client.properties.filter((p:any)=>this.allowed(current,p.id)).map((p:any)=>({id:p.id,address:[p.street1,p.street2,p.city].filter(Boolean).join(", ")})),requests:[],jobs:[],history_complete:false});
        if(input.operation_id && this.journal.hasOperation(input.operation_id))this.journal.save(input.operation_id,progress());
      }
      for(const record of records) {
        if(this.journal.checkpoint(`ended-call:${input.call_id}`))throw new WorkflowRequired("call_ended","none");
        const requests=await this.pages(clientRequests,{id:record.id},d=>d.client?.requests);
        const jobs=await this.pages(clientJobs,{id:record.id},d=>d.client?.jobs);
        const current=await this.fresh(number,record.id);
        record.requests=requests.filter(r=>r.client?.id===record.id && this.allowed(current,r.property?.id)).map(r=>({...ref(r),title:r.title?.replace(/ \[voice [0-9a-f-]+\]$/, ""),status:r.requestStatus,appointment:r.assessment ? {mode:r.assessment.startAt ? "timed":"unscheduled",start_at:r.assessment.startAt,end_at:r.assessment.endAt}:null}));
        record.jobs=jobs.filter(r=>r.client?.id===record.id && this.allowed(current,r.property?.id)).map(r=>({...ref(r),title:r.title,status:r.jobStatus}));
        record.history_complete=true;
        if(input.operation_id && this.journal.hasOperation(input.operation_id))this.journal.save(input.operation_id,progress());
      }
      return {...progress(),outcome:"completed",history_complete:true};
    }
    if (input.action === "status") { const t = await this.target(input); const record = await this.publicStatus(input.record_type!, t.record); await this.target(input); return { outcome: "completed", phone_match: "matched", record }; }
    if (input.action === "prepare") {
      const i = input.intake;
      if (!i) throw new Permanent("intake is required");
      const missing = [!i.name && "name", !normalizePhone(i.callback_number) && "callback_number", !i.description && "description", !i.service && "service"].filter(Boolean);
      return { outcome: "draft", missing_fields: missing, location_complete: knownLocation(i) || !!i.property_id, assessment_mode: "unscheduled" };
    }
    if(input.action === "preflight")return this.preflight(input);
    if (!input.operation_id || !input.confirmed) throw new Error("A confirmed submission and operation_id are required");
    const saved = this.journal.start(input.operation_id, input.call_id, input);
    if (saved.outcome !== "pending" || this.running.has(input.operation_id)) return saved;
    this.running.add(input.operation_id);
    try {
      if(input.supersedes_operation_id && this.journal.hasOperation(input.supersedes_operation_id)) {
        const prior=this.journal.get(input.supersedes_operation_id,input.call_id);
        if(prior.outcome!=="failed" || !this.journal.safeToReconfirm(input.supersedes_operation_id))throw new WorkflowRequired("unsafe_reconfirmation","staff_review");
      }
      for(const step of ["client","property","request","note","assessment"]) {
        const prior=this.journal.step(input.operation_id,step);
        if(prior?.state === "rejected")throw new ValidationRejected(step,prior.record?.validation_errors || []);
      }
      if (input.action === "message") await this.message(input, saved);
      else await this.submit(input, saved);
      saved.outcome = "completed";delete saved.current_step;delete saved.failed_step;delete saved.reason;delete saved.reason_code;delete saved.next_action;delete saved.retry_at;delete saved.safe_to_reconfirm;
    } catch (error) {
      const permanent=error instanceof Permanent || error instanceof WorkflowRequired || error instanceof JobberPermissionError || error instanceof JobberAuthenticationError;
      saved.outcome = error instanceof Uncertain ? "uncertain" : permanent ? (!this.journal.safeToReconfirm(input.operation_id) ? "partial" : "failed") : "pending";
      saved.reason_code = error instanceof WorkflowRequired ? error.code:error instanceof ValidationRejected ? "jobber_validation" : error instanceof Uncertain ? "write_uncertain" : permanent ? "validation_or_authorization" : error instanceof DirectoryIncomplete ? "directory_incomplete" : "lookup_unavailable";
      if(error instanceof WorkflowRequired){saved.next_action=error.nextAction;saved.choices=error.choices;}
      saved.failed_step=saved.current_step || "prerequisite_reads";
      if(error instanceof ValidationRejected) {saved.validation_errors=error.errors;saved.failed_step=error.step;}
      saved.safe_to_reconfirm=saved.outcome==="failed" && this.journal.safeToReconfirm(input.operation_id);
      saved.retry_at=this.journal.retryAt(input.operation_id);
      saved.reason = error instanceof Uncertain ? "Write requires reconciliation; no automatic retry." : saved.outcome==="pending" ? "Jobber read unavailable; confirmed work remains pending." : "Jobber request was not completed; staff review required.";
    } finally {
      try { this.journal.save(input.operation_id, saved); }
      finally { this.running.delete(input.operation_id);if(saved.outcome==="completed" || saved.safe_to_reconfirm)this.journal.releaseReservations(input.operation_id); }
    }
    await appendAuditLog({ account_id: this.accountId, service_session_id:"voice-service", tool: `voice_${input.action}`, args: { operation_id: input.operation_id, call_id: input.call_id, reason_code: saved.reason_code, stage: saved.failed_step || Object.keys(saved.records).at(-1) || "prerequisite_reads" }, outcome: saved.outcome === "completed" ? "success" : "error" });
    return saved;
  }
  private async write(input: VoiceInput, result: VoiceResult, step: string, query: string, variables: Record<string, unknown>, payload: string, field: string, verify: (record: any) => Promise<any>): Promise<any> {
    const id = input.operation_id!;
    result.current_step=step;
    const old = this.journal.step(id, step);
    if(old?.state === "rejected")throw new ValidationRejected(step,old.record?.validation_errors || []);
    if (old?.state === "verified") {
      result.records[step] = ref(old.record);
      return old.record;
    }
    let record = old?.record;
    if (old?.state === "dispatched") throw new Uncertain();
    if (!old) {
      if (input.action === "message" && input.record_id) await this.target(input);
      if (input.action === "submit" && result.phone_match === "matched" && result.records.client?.id) {
        const m=await this.fresh(normalizePhone(input.caller_number),result.records.client.id);
        if (!this.allowed(m,result.records.property?.id)) throw new Permanent("Property no longer accessible");
      }
      if(input.action==="submit" && (step==="note" || step==="assessment")) {
        const current=(await this.run(requestQuery,{id:result.records.request?.id},1000)).request;
        if(current?.client?.id!==result.records.client?.id || current?.property?.id!==result.records.property?.id)throw new WorkflowRequired("destination_changed","staff_review");
        if(result.phone_match==="matched")await this.target({...input,record_type:"request",record_id:current.id});
      }
      if ((await this.run(`query VoiceAccount{account{id}}`, {}, 1)).account?.id !== this.accountId) throw new Permanent("Voice Jobber account mismatch");
      this.journal.dispatched(id, step);
      try {
        const data = await this.run(query, variables, 300);
        record = data[payload]?.[field];
        if (Array.isArray(record)) record = record.length === 1 ? record[0] : null;
        if (record?.id) {
          this.journal.returned(id, step, record);
          result.records[step] = ref(record); this.journal.save(id, result);
        }
        const errors=data[payload]?.userErrors;
        if(!record?.id && Array.isArray(errors) && errors.length && !hasMutationExecutionErrors(data)) {
          const details=errors.slice(0,10).map((e:any)=>({message:String(e.message || "Jobber rejected this input").slice(0,500),path:Array.isArray(e.path) ? e.path.map(String):[]}));
          this.journal.rejected(id,step,details);
          throw new ValidationRejected(step,details);
        }
        if (!record?.id || errors?.length || !Array.isArray(errors)) throw new Uncertain();
      } catch (error) {
        if(error instanceof ValidationRejected)throw error;
        if(error instanceof BudgetUnavailableError || error instanceof RequestRateLimitError) {this.journal.notDispatched(id,step);throw error;}
        throw new Uncertain();
      }
    }
    try {
      const checked = await verify(record);
      if (!checked || checked.id !== record!.id) throw new Error("Readback mismatch");
      this.journal.verified(id, step, checked); result.records[step] = ref(checked); this.journal.save(id, result);
      return checked;
    } catch { throw new Uncertain(); }
  }
  private async reconcile(input: VoiceInput, result: VoiceResult): Promise<VoiceResult> {
    // Read-only recovery. Never infer that a missing record proves a write did not happen.
    const id = input.operation_id!;
    try {
      const clientStep = this.journal.step(id,"client");
      if (clientStep?.state === "returned" && input.intake) {
        const c = (await this.run(clientQuery,{id:clientStep.record?.id},1000)).client;
        const i=input.intake;
        if (c?.id === clientStep.record?.id && c.firstName === i.name && !(c.lastName || "") && (c.companyName || "") === i.company && c.phones.some((p:any)=>normalizePhone(p.number)===normalizePhone(i.callback_number)) && (!i.email || c.emails.some((e:any)=>e.address.toLowerCase()===i.email.toLowerCase()))) { this.journal.verified(id,"client",c); result.records.client=ref(c); }
      }
      const propertyStep = this.journal.step(id,"property");
      if (propertyStep?.state === "returned" && result.records.client?.id && input.intake) {
        const c=(await this.run(clientQuery,{id:result.records.client.id},1000)).client;
        const i=input.intake;
        const p=c?.properties.find((p:any)=>p.id===propertyStep.record?.id && p.street1===i.street1 && (p.street2 || "")===i.street2 && p.city===i.city);
        if (p) {this.journal.verified(id,"property",p);result.records.property=ref(p);}
      }
      const requestStep = this.journal.step(id,"request");
      if (requestStep && requestStep.state !== "verified" && result.records.client?.id) {
        const candidates = await this.pages(clientRequests,{id:result.records.client.id}, d => d.client?.requests);
        const found = candidates.filter(r => r.title?.endsWith(`[voice ${id}]`) && r.client.id === result.records.client.id && r.property?.id === result.records.property?.id);
        if (found.length === 1) { this.journal.verified(id,"request",found[0]); result.records.request = ref(found[0]); }
      }
      const type = input.action === "message" ? input.record_type : "request";
      const parentId = input.action === "message" ? input.record_id : result.records.request?.id;
      const noteStep = this.journal.step(id,"note");
      if(input.action==="submit" && parentId && (noteStep || this.journal.step(id,"assessment"))) {
        const actual=(await this.run(requestQuery,{id:parentId},1000)).request;
        if(actual?.client?.id!==result.records.client?.id || actual?.property?.id!==result.records.property?.id)throw new WorkflowRequired("destination_changed","staff_review");
        if(result.phone_match==="matched")await this.target({...input,record_type:"request",record_id:parentId});
      }
      if (type && parentId && noteStep && noteStep.state !== "verified") {
        const found = (await this.pages(notes[type].query,{id:parentId},d=>d[type]?.notes)).filter(n=>n.message===this.noteText(input));
        if (found.length === 1) {this.journal.verified(id,"note",found[0]); result.records.note=ref(found[0]);}
      }
      const assessmentStep = this.journal.step(id,"assessment");
      if (assessmentStep && assessmentStep.state !== "verified" && result.records.request?.id) {
        const request = (await this.run(requestQuery,{id:result.records.request.id},1000)).request;
        const a = request?.assessment;
        if (a?.instructions === `Voice operation: ${id}` && !a.startAt && !a.endAt && a.assignedUsers?.nodes.length === 0 && !a.assignedUsers?.pageInfo.hasNextPage) {
          this.journal.verified(id,"assessment",a); result.records.assessment={...ref(a),url:url(request)};
        }
      }
      // The step journal is authoritative, including after a crash between
      // verifying a step and saving its public result.
      for (const step of ["client","property","request","note","assessment"]) {
        const verified = this.journal.step(id,step);
        if (verified?.state === "verified" && verified.record?.id) result.records[step] = ref(verified.record);
      }
      if (result.records.assessment && result.records.request?.url) result.records.assessment.url = result.records.request.url;
      const required = input.action === "message" ? ["note"] : ["request","note",...(input.intake?.assessment && result.records.property ? ["assessment"] : [])];
      if (required.every(step=>this.journal.step(id,step)?.state === "verified")) {
        result.outcome="completed"; delete result.reason;
        if (input.action === "submit") {result.assessment_mode=result.records.assessment ? "unscheduled":"not_created"; result.missing_location=!result.records.property;}
      }
      this.journal.save(id,result);
      if (result.outcome === "uncertain" && ["client","property","request","note","assessment"].every(step => { const prior=this.journal.step(id,step); return !prior || prior.state === "verified"; })) {
        result.outcome="pending"; this.journal.save(id,result);
      }
    } catch(error) {
      // Changed ownership must remain visible while the original mutation is
      // reconciled; it is never permission to replay it against another parent.
      if(error instanceof WorkflowRequired) {
        result.reason_code=error.code;result.next_action=error.nextAction;
        result.failed_step=result.current_step || "reconciliation";
      }
    }
    result.retry_at=this.journal.retryAt(id);this.journal.save(id,result);
    return result;
  }
  private noteText(input: VoiceInput): string {
    const i = input.action === "submit" ? input.intake : undefined;
    const body = i ? Object.entries(i).filter(([k,v]) => v && !["property_id","client_id","assessment"].includes(k)).map(([k,v]) => `${k.replace(/_/g," ")}: ${v}`).join("\n") : input.message!;
    return `Customer phone intake\n${body}\n\nVoice operation: ${input.operation_id}`;
  }
  private async note(input: VoiceInput, result: VoiceResult, type: "client" | "request" | "job", id: string): Promise<void> {
    const message = this.noteText(input), spec = notes[type];
    await this.write(input, result, "note", spec.mutation, { id, input: { message, pinned: false } }, spec.payload, spec.field, async r => {
      const found = (await this.pages(spec.query, { id }, d => d[type]?.notes)).find(n => n.id === r.id && n.message === message);
      return found;
    });
  }
  private async message(input: VoiceInput, result: VoiceResult): Promise<void> {
    if (!input.message?.trim()) throw new Permanent("message is required");
    if (!input.record_id) { result.phone_match = "unverified"; result.email_only = true; return; }
    const { record } = await this.target(input);
    result.phone_match = "matched"; result.records[input.record_type!] = ref(record);
    await this.note(input, result, input.record_type!, record.id);
  }
  private async submit(input: VoiceInput, result: VoiceResult): Promise<void> {
    let i = input.intake;
    if (!i || !i.name || !i.description || !i.service || !normalizePhone(i.callback_number)) throw new Permanent("Incomplete intake");
    if(input.workflow_version===2) {
      if(!input.preflight_id)throw new WorkflowRequired("preflight_required","preflight");
      const receipt=this.journal.get(input.preflight_id,input.call_id);
      const prepared=voiceInput.parse(this.journal.input(input.preflight_id,input.call_id));
      if(prepared.action!=="preflight" || normalizePhone(prepared.caller_number)!==normalizePhone(input.caller_number) || receipt.preflight_state!=="ready" || receipt.intake_fingerprint!==fingerprint(i))throw new WorkflowRequired("preflight_changed","preflight");
      i={...i,...(receipt.destination.client_id ? {client_id:receipt.destination.client_id}:{}),...(receipt.destination.property_id ? {property_id:receipt.destination.property_id}:{})};
    }
    const number = normalizePhone(input.caller_number);
    const previouslyDispatched = this.journal.step(input.operation_id!, "client");
    const matches = previouslyDispatched ? [] : i.client_id ? [await this.fresh(number,i.client_id)] : await this.matches(number,true);
    let client: any, property: any;
    if(result.phone_match==="matched" && result.records.client?.id) {
      const selected=await this.fresh(number,result.records.client.id);
      client=selected.client;property=client.properties.find((p:any)=>p.id===result.records.property?.id);
      if(result.records.property && (!property || !this.allowed(selected,property.id)))throw new WorkflowRequired("destination_changed","staff_review");
    } else if (previouslyDispatched) {
      if (previouslyDispatched.state === "dispatched" || !previouslyDispatched.record?.id) throw new Uncertain();
      client = (await this.run(clientQuery,{id:previouslyDispatched.record.id},1000)).client;
      if (!client || !client.phones.some((p: any) => normalizePhone(p.number) === normalizePhone(i.callback_number))) throw new Uncertain();
    } else if (matches.length) {
      const destination=await this.destination({...input,intake:i});
      const selected = matches.find(m=>m.client.id===destination.client?.id);
      if (!selected) throw new WorkflowRequired("client_selection_required","select_client");
      const m = await this.fresh(number, selected.client.id); client = m.client;
      const candidates = client.properties.filter((p:any)=>i.property_id ? p.id === i.property_id : sameAddress(p,i));
      if (candidates.length > 1) throw new WorkflowRequired("property_selection_required","select_property");
      property = candidates[0];
      if (i.property_id && !property || property && !this.allowed(m, property.id) || m.propertyIds && !property) throw new Permanent("Property not accessible");
    } else {
      if (i.client_id || i.property_id) throw new Permanent("Existing records require a matched calling number");
      if(!knownLocation(i))throw new WorkflowRequired("missing_location","collect_location");
      const censusEpoch=this.journal.checkpoint(`client-creation-epoch:${this.accountId}`)?.value;
      await this.checkDuplicates({...input,intake:i});
      client = await this.gates.run("new-client",async()=>{
        // Another voice operation may have created a client after our last
        // census read. Repeat discovery outside this gate before any mutation.
        if(censusEpoch!==this.journal.checkpoint(`client-creation-epoch:${this.accountId}`)?.value)throw new DirectoryIncomplete("Client census changed before creation");
        const keys=[`phone:${normalizePhone(i!.callback_number)}`,`name:${normalizedText(i!.company || i!.name)}`,`address:${normalizedStreet(i!.street1)}:${normalizedText(i!.street2)}:${normalizedText(i!.city)}`];
        if(!this.journal.reserve(keys,input.operation_id!))throw new WorkflowRequired("creation_reserved","staff_review");
        this.journal.setCheckpoint(`client-creation-epoch:${this.accountId}`,{value:randomUUID()});
      return await this.write(input, result, "client", newClient, { input: { firstName: i.name, ...(i.company ? { companyName: i.company, isCompany: true } : {}), phones: [{ number: normalizePhone(i.callback_number), primary: true, smsAllowed: false }], emails: i.email ? [{ address: i.email, primary: true }] : [], receivesReminders: false, receivesFollowUps: false, receivesQuoteFollowUps: false, receivesInvoiceFollowUps: false, receivesReviewRequests: false } }, "clientCreate", "client", async r => {
        const current = (await this.run(clientQuery, { id: r.id }, 1000)).client;
        return current?.firstName === i.name && !(current.lastName || "") && (current.companyName || "") === i.company && current.phones.some((p: any) => normalizePhone(p.number) === normalizePhone(i.callback_number)) && (!i.email || current.emails.some((e: any) => e.address.toLowerCase() === i.email.toLowerCase())) ? current : null;
      });
      });
    }
    result.records.client = ref(client); result.phone_match = result.phone_match === "matched" || matches.length ? "matched" : "unmatched";
    if (matches.length) await this.fresh(number,client.id);
    if (!property && knownLocation(i)) {
      property=await this.gates.run(`property:${client.id}`,async()=>{
        const current=(await this.run(clientQuery,{id:client.id},1500)).client;
        const found=current?.properties.filter((p:any)=>sameAddress(p,i)) || [];
        if(found.length>1)throw new WorkflowRequired("property_selection_required","select_property");
        if(found.length===1)return found[0];
      return await this.write(input, result, "property", newProperty, { id: client.id, input: { properties: [{ address: { street1: i.street1, street2: i.street2, city: i.city, province: i.province || undefined, postalCode: i.postal_code || undefined } }] } }, "propertyCreate", "properties", async r => (await this.run(clientQuery, { id: client.id }, 1000)).client?.properties.find((p: any) => p.id === r.id && sameAddress(p,i)));
      });
    }
    if (property) result.records.property = ref(property);
    if(!property)throw new WorkflowRequired("missing_location","collect_location");
    // A per-operation title marker provides a reconciliation handle without copying private call IDs.
    const title = `${i.service.slice(0,50)}: ${i.description.slice(0,70)} [voice ${input.operation_id}]`;
    const request = await this.write(input, result, "request", newRequest, { input: { clientId: client.id, propertyId: property.id, title } }, "requestCreate", "request", async r => {
      const current = (await this.run(requestQuery, { id: r.id }, 1000)).request;
      return current?.client.id === client.id && current?.property?.id === property?.id && current?.title === title ? current : null;
    });
    if (matches.length) await this.fresh(number,client.id);
    await this.note(input, result, "request", request.id);
    if (i.assessment && property) {
      await this.write(input, result, "assessment", newAssessment, { id: request.id, input: { instructions: `Voice operation: ${input.operation_id}`, schedule: { notifyTeam: false, teamMemberIdsToAssign: [] } } }, "assessmentCreate", "assessment", async r => {
        const current = (await this.run(requestQuery, { id: request.id }, 1000)).request?.assessment;
        return current?.id === r.id && current.instructions === `Voice operation: ${input.operation_id}` && !current.startAt && !current.endAt && current.assignedUsers?.nodes.length === 0 && current.assignedUsers?.pageInfo.hasNextPage === false ? current : null;
      });
      result.records.assessment.url = url(request);
    }
    result.assessment_mode = i.assessment && property ? "unscheduled" : "not_created";
    result.missing_location = !property;
  }
}
