import { BudgetUnavailableError, RequestRateLimitError } from "../jobber/cost-governor.js";
import { JobberPermissionError, JobberAuthenticationError, JobberGraphQLRequestError } from "../jobber/client.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { VoiceDirectory, DirectoryIncomplete } from "./directory.js";
import { fingerprint } from "./journal.js";
import { z } from "zod";
import type { VoiceJournal, VoiceResult } from "./journal.js";
import { appendAuditLog } from "../utils/auditLog.js";

export type RunQuery = (query: string, variables?: Record<string, unknown>, maxCost?: number) => Promise<any>;
const text = z.string().trim().max(10000);
export const voiceInput = z.object({
  action: z.enum(["resolve", "status", "prepare", "submit", "message", "operation_status"]),
  call_id: z.string().min(1).max(200), caller_number: z.string().max(80),
  operation_id: z.string().uuid().optional(), record_type: z.enum(["client", "request", "job"]).optional(), record_id: z.string().max(200).optional(),
  confirmed: z.boolean().default(false),
  intake: z.object({
    name: text.default(""), callback_number: text.default(""), company: text.default(""), email: z.union([z.literal(""), z.string().email()]).default(""),
    description: text.default(""), service: text.default(""), street1: text.default(""), street2: text.default(""), city: text.default(""),
    province: text.default(""), postal_code: text.default(""), access: text.default(""), urgency: text.default(""), timing: text.default(""),
    notes: text.default(""), assessment: z.boolean().default(true), property_id: z.string().max(200).optional(), client_id: z.string().max(200).optional(),
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
function knownLocation(i: NonNullable<VoiceInput["intake"]>): boolean { return !!(i.street1 && i.city && /\d/.test(i.street1)); }
function sameAddress(p: any, i: NonNullable<VoiceInput["intake"]>): boolean { return !!(i.street1 && i.city && p.street1?.trim().toLowerCase() === i.street1.toLowerCase() && (p.street2 || "").trim().toLowerCase() === i.street2.toLowerCase() && p.city?.trim().toLowerCase() === i.city.toLowerCase()); }
type Match = { client: any; propertyIds: Set<string> | null };
function url(record: any): string | undefined {
  try { const u = new URL(record.jobberWebUri); return u.protocol === "https:" && (u.hostname === "secure.getjobber.com" || u.hostname.endsWith(".getjobber.com")) ? u.href : undefined; } catch { return undefined; }
}
function ref(record: any): VoiceResult { return { id: record.id, ...(url(record) ? { url: url(record) } : {}) }; }

export class VoiceService {
  private running = new Set<string>();
  private writeTail: Promise<void> = Promise.resolve();
  private jobs = new Map<string, Promise<VoiceResult>>();
  private lookupContext = new AsyncLocalStorage<string>();
  readonly directory: VoiceDirectory;
  constructor(private journal: VoiceJournal, private run: RunQuery, private accountId: string) { this.directory=new VoiceDirectory(journal,run,accountId); }
  directoryHealth(): Record<string,unknown> {return this.directory.status();}
  async tick():Promise<void> { for(const op of this.journal.pending()) this.launch(voiceInput.parse(this.journal.input(op.id,op.call))); }
  /** Private HTTP dispatch is always quick; the journal owns unfinished work. */
  async dispatch(raw:unknown):Promise<VoiceResult> {
    const input=voiceInput.parse(raw);
    if(input.action==="prepare") return this.execute(input);
    if(input.action==="operation_status") {
      if(!input.operation_id)throw new Permanent("operation_id required");
      let result:VoiceResult;try{result=this.journal.get(input.operation_id,input.call_id);}catch{return {outcome:"not_found",operation_id:input.operation_id};}
      const original=voiceInput.parse(this.journal.input(input.operation_id,input.call_id));
      if(result.outcome==="completed" && ["resolve","status"].includes(original.action)) {
        // A stored read result is not ongoing permission to disclose a customer's records.
        result={operation_id:input.operation_id,outcome:"pending",records:{}};
        this.journal.save(input.operation_id,result);
        const work=this.launch(original);let timer:ReturnType<typeof setTimeout>;
        try{return await Promise.race([work,new Promise<VoiceResult>(r=>{timer=setTimeout(()=>r(this.journal.get(input.operation_id!,input.call_id)),2000);})]);}finally{clearTimeout(timer!);}
      }
      if(["pending","uncertain"].includes(result.outcome) && (!result.retry_at || result.retry_at<=Date.now())) this.launch(voiceInput.parse(this.journal.input(input.operation_id,input.call_id)));
      return result;
    }
    if(!input.operation_id) input.operation_id=randomUUID();
    const saved=this.journal.start(input.operation_id,input.call_id,input);
    if(!["pending","uncertain"].includes(saved.outcome))return saved;
    const work=this.launch(input);
    let timer:ReturnType<typeof setTimeout>;
    const timeout=new Promise<VoiceResult>(resolve=>{timer=setTimeout(()=>resolve(this.journal.get(input.operation_id!,input.call_id)),2000);});
    try{return await Promise.race([work,timeout]);}finally{clearTimeout(timer!);}
  }
  private launch(input:VoiceInput):Promise<VoiceResult> {
    const id=input.operation_id!;
    const old=this.jobs.get(id);if(old)return old;
    const task=this.lookupContext.run(id,async()=>{
      let result:VoiceResult;
      try {
        const prior=this.journal.get(id,input.call_id);
        result=prior.outcome==="uncertain" ? await this.execute({action:"operation_status",operation_id:id,call_id:input.call_id,caller_number:input.caller_number}) : await this.execute(input);
      }catch(error){
        const permanent=error instanceof Permanent || error instanceof JobberPermissionError || error instanceof JobberAuthenticationError || error instanceof JobberGraphQLRequestError;
        result=this.journal.get(id,input.call_id);result.outcome=permanent ? "failed":"pending";
        result.reason_code=permanent ? "validation_or_authorization":"lookup_unavailable";
        result.retry_at=Date.now()+15000;
      }
      result.operation_id=id; this.journal.save(id,result);if(result.outcome==="completed")this.journal.clearScan(id);return result;
    }).finally(()=>{this.jobs.delete(id);});
    this.jobs.set(id,task);return task;
  }
  private async scan(query:string,variables:Record<string,unknown>):Promise<any> {
    const id=this.lookupContext.getStore();const memo=/query Voice(?:Clients|Contacts|ContactEmails)\(/.test(query);const key=id && memo ? `scan:${id}:${fingerprint({query,variables})}`:undefined;
    const saved=key && this.journal.checkpoint(key);if(saved)return saved;
    const result=await this.run(query,variables,this.cost(query));
    if(key) {
      const c=result.clients || result.client?.contacts;
      if(!Array.isArray(c?.nodes) || typeof c.pageInfo?.hasNextPage!=="boolean" || c.pageInfo.hasNextPage && (!c.pageInfo.endCursor || c.pageInfo.endCursor===variables.after))throw new DirectoryIncomplete("Incomplete Jobber lookup");
      this.journal.setCheckpoint(key,result);
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
        if (contact.name?.trim().toLowerCase() === name.toLowerCase() || email && emails.some((e: any) => e.address.toLowerCase() === email.toLowerCase())) duplicate = true;
      }
      if (!connection.pageInfo.hasNextPage) return duplicate;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) throw new Error("Incomplete duplicate lookup");
      after = connection.pageInfo.endCursor;
    }
    throw new Error("Incomplete duplicate lookup");
  }
  private async matches(number: string | null): Promise<Match[]> {
    if (!number) return [];
    const matches: Match[] = [];
    const candidates=this.lookupContext.getStore() ? this.directory.candidates(number):undefined;
    if(this.lookupContext.getStore() && candidates===undefined) {await this.directory.refresh();}
    const ids=this.lookupContext.getStore() ? this.directory.candidates(number):undefined;
    if(ids?.length) {for(const id of ids){const c=(await this.run(clientQuery,{id},1500)).client;if(c){const m=await this.lookupContext.run("",()=>this.match(c,number,true));if(m)matches.push(m);}}}
    else {for (const c of await this.clients()) { const m = await this.match(c, number); if (m) matches.push(m); }}
    return matches;
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
      const matched = await this.matches(normalizePhone(input.caller_number));
      const records = [];
      for (const m of matched) {
        await this.fresh(normalizePhone(input.caller_number),m.client.id);
        const requests=await this.pages(clientRequests,{id:m.client.id},d=>d.client?.requests);
        const jobs=await this.pages(clientJobs,{id:m.client.id},d=>d.client?.jobs);
        const current = await this.fresh(normalizePhone(input.caller_number), m.client.id);
        records.push({ record_type: "client", ...ref(current.client), name: current.client.name, selectable: !current.propertyIds,
          properties: current.client.properties.filter((p: any) => this.allowed(current, p.id)).map((p: any) => ({ id: p.id, address: [p.street1,p.street2,p.city].filter(Boolean).join(", ") })),
          requests: requests.filter(r => this.allowed(current, r.property?.id)).map(r => ({ ...ref(r), title: r.title })),
          jobs: jobs.filter(r => this.allowed(current, r.property?.id)).map(r => ({ ...ref(r), title: r.title })) });
      }
      return { outcome: "completed", phone_match: matched.length ? "matched" : "unmatched", records };
    }
    if (input.action === "status") { const t = await this.target(input); const record = await this.publicStatus(input.record_type!, t.record); await this.target(input); return { outcome: "completed", phone_match: "matched", record }; }
    if (input.action === "prepare") {
      const i = input.intake;
      if (!i) throw new Permanent("intake is required");
      const missing = [!i.name && "name", !normalizePhone(i.callback_number) && "callback_number", !i.description && "description", !i.service && "service"].filter(Boolean);
      return { outcome: "draft", missing_fields: missing, location_complete: knownLocation(i) || !!i.property_id, assessment_mode: "unscheduled" };
    }
    if (!input.operation_id || !input.confirmed) throw new Error("A confirmed submission and operation_id are required");
    const saved = this.journal.start(input.operation_id, input.call_id, input);
    if (saved.outcome !== "pending" || this.running.has(input.operation_id)) return saved;
    this.running.add(input.operation_id);
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (input.action === "message") await this.message(input, saved);
      else await this.submit(input, saved);
      saved.outcome = "completed";
    } catch (error) {
      const permanent=error instanceof Permanent || error instanceof JobberPermissionError || error instanceof JobberAuthenticationError || error instanceof JobberGraphQLRequestError;
      saved.outcome = error instanceof Uncertain ? "uncertain" : permanent ? (Object.keys(saved.records).length ? "partial" : "failed") : "pending";
      saved.reason_code = error instanceof Uncertain ? "write_uncertain" : permanent ? "validation_or_authorization" : error instanceof DirectoryIncomplete ? "directory_incomplete" : "lookup_unavailable";
      saved.retry_at=Date.now()+15000;
      saved.reason = error instanceof Uncertain ? "Write requires reconciliation; no automatic retry." : saved.outcome==="pending" ? "Jobber read unavailable; confirmed work remains pending." : "Jobber request was not completed; staff review required.";
    } finally {
      try { this.journal.save(input.operation_id, saved); }
      finally { this.running.delete(input.operation_id); release(); }
    }
    await appendAuditLog({ account_id: this.accountId, service_session_id:"voice-service", tool: `voice_${input.action}`, args: { operation_id: input.operation_id, call_id: input.call_id, reason_code: saved.reason_code, stage: Object.keys(saved.records).at(-1) || "prerequisite_reads" }, outcome: saved.outcome === "completed" ? "success" : "error" });
    return saved;
  }
  private async write(input: VoiceInput, result: VoiceResult, step: string, query: string, variables: Record<string, unknown>, payload: string, field: string, verify: (record: any) => Promise<any>): Promise<any> {
    const id = input.operation_id!;
    const old = this.journal.step(id, step);
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
        if (!record?.id || data[payload]?.userErrors?.length || !Array.isArray(data[payload]?.userErrors)) throw new Uncertain();
      } catch (error) {
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
    } catch { /* Retain uncertainty when reads cannot prove the entire intended result. */ }
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
    const i = input.intake;
    if (!i || !i.name || !i.description || !i.service || !normalizePhone(i.callback_number)) throw new Permanent("Incomplete intake");
    const number = normalizePhone(input.caller_number);
    const previouslyDispatched = this.journal.step(input.operation_id!, "client");
    const matches = previouslyDispatched ? [] : await this.matches(number);
    let client: any, property: any;
    if (previouslyDispatched) {
      if (previouslyDispatched.state === "dispatched" || !previouslyDispatched.record?.id) throw new Uncertain();
      client = (await this.run(clientQuery,{id:previouslyDispatched.record.id},1000)).client;
      if (!client || !client.phones.some((p: any) => normalizePhone(p.number) === normalizePhone(i.callback_number))) throw new Uncertain();
    } else if (matches.length) {
      const selected = i.client_id ? matches.find(m => m.client.id === i.client_id) : matches.length === 1 ? matches[0] : undefined;
      if (!selected) throw new Permanent("Select client");
      const m = await this.fresh(number, selected.client.id); client = m.client;
      const candidates = client.properties.filter((p:any)=>i.property_id ? p.id === i.property_id : sameAddress(p,i));
      if (candidates.length > 1) throw new Permanent("Ambiguous property requires staff review");
      property = candidates[0];
      if (i.property_id && !property || property && !this.allowed(m, property.id) || m.propertyIds && !property) throw new Permanent("Property not accessible");
    } else {
      if (i.client_id || i.property_id) throw new Permanent("Existing records require a matched calling number");
      // Include linked contact phones/emails in duplicate checks, even when caller ID differs.
      for (const c of await this.clients()) {
        if (c.properties.some((p:any)=>sameAddress(p,i)) || await this.duplicateContact(c.id, i.name, i.email) || await this.match(c, normalizePhone(i.callback_number)! ) || c.name?.trim().toLowerCase() === (i.company || i.name).toLowerCase() || i.email && c.emails.some((e: any) => e.address.toLowerCase() === i.email.toLowerCase())) throw new Permanent("Potential duplicate requires staff review");
      }
      client = await this.write(input, result, "client", newClient, { input: { firstName: i.name, ...(i.company ? { companyName: i.company, isCompany: true } : {}), phones: [{ number: normalizePhone(i.callback_number), primary: true, smsAllowed: false }], emails: i.email ? [{ address: i.email, primary: true }] : [], receivesReminders: false, receivesFollowUps: false, receivesQuoteFollowUps: false, receivesInvoiceFollowUps: false, receivesReviewRequests: false } }, "clientCreate", "client", async r => {
        const current = (await this.run(clientQuery, { id: r.id }, 1000)).client;
        return current?.firstName === i.name && !(current.lastName || "") && (current.companyName || "") === i.company && current.phones.some((p: any) => normalizePhone(p.number) === normalizePhone(i.callback_number)) && (!i.email || current.emails.some((e: any) => e.address.toLowerCase() === i.email.toLowerCase())) ? current : null;
      });
    }
    result.records.client = ref(client); result.phone_match = matches.length ? "matched" : "unmatched";
    if (matches.length) await this.fresh(number,client.id);
    if (!property && knownLocation(i)) {
      property = await this.write(input, result, "property", newProperty, { id: client.id, input: { properties: [{ address: { street1: i.street1, street2: i.street2, city: i.city, province: i.province || undefined, postalCode: i.postal_code || undefined } }] } }, "propertyCreate", "properties", async r => (await this.run(clientQuery, { id: client.id }, 1000)).client?.properties.find((p: any) => p.id === r.id && p.street1 === i.street1 && (p.street2 || "") === i.street2 && p.city === i.city));
    }
    if (property) result.records.property = ref(property);
    // A per-operation title marker provides a reconciliation handle without copying private call IDs.
    const title = `${i.service.slice(0,50)}: ${i.description.slice(0,70)} [voice ${input.operation_id}]`;
    const request = await this.write(input, result, "request", newRequest, { input: { clientId: client.id, propertyId: property?.id, title } }, "requestCreate", "request", async r => {
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
