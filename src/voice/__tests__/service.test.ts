import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { VoiceJournal } from "../journal.js";
import { VoiceService, normalizePhone } from "../service.js";
import { registerVoiceRoutes } from "../http.js";
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: vi.fn() }));
const pi = { hasNextPage: false, endCursor: null };
const conn = (nodes: any[]) => ({ nodes, pageInfo: pi });
const client = { id: "c1", name: "Jane Doe", firstName: "Jane", lastName: "Doe", companyName: "", phones: [{ number: "(705) 555-0100" }], emails: [], properties: [{ id: "p1", street1: "1 Main", street2: "", city: "Englehart" }], jobberWebUri: "https://secure.getjobber.com/clients/c1" };
const dirs: string[] = [], journals: VoiceJournal[] = [];
function fixture(existing = true) {
 const dir = mkdtempSync(path.join(os.tmpdir(), "jobber-voice-")); dirs.push(dir);
 const journal = new VoiceJournal(path.join(dir, "voice.db")); journals.push(journal);
 const cs: any[] = existing ? [structuredClone(client)] : [];
 const requests: any[] = [], noteRecords: any[] = [];
 let assessment: any = null;
 const run = vi.fn(async (query: string, vars: any = {}) => {
  if (query.includes("VoiceAccount")) return { account: { id: "williams" } };
  if (query.includes("VoiceClients(")) return { clients: conn(cs) };
  if (query.includes("VoiceCensusClients")) return {clients:conn(cs.map(c=>({...c,contacts:conn(c.contacts || [])})))};
  if (query.includes("VoiceClient(")) return { client: cs.find(c => c.id === vars.id) };
  if ((query.includes("VoiceContacts") || query.includes("VoiceContactEmails"))) return { client: { contacts: conn([]) } };
  if (query.includes("VoiceClientRequests")) return { client: { requests: conn(requests) } };
  if (query.includes("VoiceClientJobs")) return { client: { jobs: conn([]) } };
  if (query.includes("VoiceCreateClient")) {
   const c = { ...structuredClone(client), id: "created-client", name: vars.input.firstName, phones: vars.input.phones, firstName: vars.input.firstName, lastName: vars.input.lastName || "", companyName: vars.input.companyName || "", emails: vars.input.emails, properties: [] }; cs.push(c); return { clientCreate: { client: c, userErrors: [] } };
  }
  if (query.includes("VoiceCreateProperty")) { const p = { ...vars.input.properties[0].address, id: "created-property" }; cs.find(c => c.id === vars.id).properties.push(p); return { propertyCreate: { properties: [p], userErrors: [] } }; }
  if (query.includes("VoiceCreateRequest")) { const r = { id: "r1", title: vars.input.title, requestStatus: "NEW", client: { id: vars.input.clientId }, property: vars.input.propertyId ? { id: vars.input.propertyId } : null, jobberWebUri: "https://secure.getjobber.com/requests/r1" }; requests.push(r); return { requestCreate: { request: r, userErrors: [] } }; }
  if (query.includes("VoiceRequest(")) return { request: { ...requests.find(r => r.id === vars.id), assessment } };
  if (query.includes("mutation VoiceRequestNote(")) { const n = { id: "n1", message: vars.input.message }; noteRecords.push(n); return { requestCreateNote: { requestNote: n, userErrors: [] } }; }
  if (query.includes("VoiceRequestNotes")) return { request: { notes: conn(noteRecords) } };
  if (query.includes("VoiceCreateAssessment")) { assessment = { id: "a1", instructions: vars.input.instructions, startAt: null, endAt: null, assignedUsers: conn([]) }; return { assessmentCreate: { assessment, userErrors: [] } }; }
  throw new Error(`Unhandled fixture query ${query}`);
 });
 return { service: new VoiceService(journal, run, "williams"), journal, run, cs, requests, noteRecords };
}
afterEach(() => { journals.splice(0).forEach(j => j.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const intake = { name: "Alex", callback_number: "+17055550101", service: "Plumbing", description: "Leaking tap", street1: "2 Main", city: "Englehart", assessment:true, timing: "Friday afternoon" };
const input = () => ({ action: "submit", call_id: "call1", caller_number: "+17055550101", operation_id: randomUUID(), confirmed: true, intake });
describe("Williams voice boundary", () => {
 it("normalizes complete numbers and rejects identity guesses", () => {
  expect(normalizePhone("705.555.0100")).toBe("+17055550100");
  for (const p of ["5550100", "sip:+17055550100", "{{number}}", "abc7055550100", "+1+7055550100", "705+5550100", ""]) expect(normalizePhone(p)).toBeNull();
  expect(normalizePhone("+442079460000")).toBe("+442079460000");
 });
 it("checks the configured account before any record read", async () => {
  const f = fixture(); f.run.mockResolvedValueOnce({ account: { id: "foreign" } });
  await expect(f.service.execute({ action: "resolve", call_id: "call1", caller_number: client.phones[0].number })).rejects.toThrow("account mismatch");
  expect(f.run).toHaveBeenCalledTimes(1);
 });
 it("matches formatted caller numbers and does not accept an altered callback as identity", async () => {
  const f = fixture();
  expect((await f.service.execute({ action: "resolve", call_id: "call1", caller_number: "+17055550100" })).phone_match).toBe("matched");
  const result = await f.service.execute({ action: "message", call_id: "call1", caller_number: "+17055550101", record_type: "client", record_id: "c1", message: "Update", confirmed: true, operation_id: randomUUID() });
  expect(result.outcome).toBe("failed"); expect(f.run.mock.calls.some(([q]) => q.startsWith("mutation"))).toBe(false);
 });
 it("fails closed for incomplete pagination", async () => {
  const f = fixture(); f.run.mockImplementation(async q => q.includes("VoiceAccount") ? { account: { id: "williams" } } : { clients: { nodes: [client], pageInfo: { hasNextPage: true, endCursor: null } } });
  await expect(f.service.execute({ action: "resolve", call_id: "call1", caller_number: "+17055550100" })).rejects.toThrow("Incomplete");
 });
 it("restricts contact matches to their associated properties", async () => {
  const f = fixture(); f.cs[0].phones = [];
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (q, v) => q.includes("VoiceContacts") ? { client: { contacts: conn([{ id: "ct", phones: conn([{ number: "+17055550100" }]), properties: conn([{ id: "other-property" }]) }]) } } : original(q, v));
  const result = await f.service.execute({ action: "resolve", call_id: "call1", caller_number: "+17055550100" });
  expect(result.records[0].properties).toEqual([]); expect(result.records[0].selectable).toBe(false);
 });
 it("requires its own credential and rejects browser-origin requests", async () => {
  const f = fixture(), app = new Hono(), key = "voice-fixture-only-".padEnd(40, "x"); registerVoiceRoutes(app, f.service, key);
  expect((await app.request("/voice/v1/execute", { method: "POST", headers: { Authorization: "Bearer staff-key" }, body: "{}" })).status).toBe(401);
  expect((await app.request("/voice/v1/execute", { method: "POST", headers: { Authorization: `Bearer ${key}`, Origin: "https://example.com" }, body: "{}" })).status).toBe(403);
 });
});
describe("durable intake", () => {
 it("creates a single-name client, property, request, note and unscheduled assessment", async () => {
  const f = fixture(false), args = input(), result = await f.service.execute(args);
  expect(result.outcome).toBe("completed"); expect(result.assessment_mode).toBe("unscheduled");
  const calls = f.run.mock.calls;
  const creation = calls.find(([q]) => q.includes("VoiceCreateClient"))![1];
  expect(creation.input.lastName).toBeUndefined(); expect(creation.input.phones[0].smsAllowed).toBe(false);
  const assessment = calls.find(([q]) => q.includes("VoiceCreateAssessment"))![1];
  expect(assessment.input.schedule).toEqual({ notifyTeam: false, teamMemberIdsToAssign: [] });
  expect(f.noteRecords[0].message).toContain("Friday afternoon");
  const writes = calls.filter(([q]) => q.startsWith("mutation")).length;
  expect((await f.service.execute(args)).outcome).toBe("completed");
  expect(f.run.mock.calls.filter(([q]) => q.startsWith("mutation")).length).toBe(writes);
  await expect(f.service.execute({ ...args, intake: { ...intake, description: "Different" } })).rejects.toThrow("collision");
 });
 it("keeps a useful request without inventing a property", async () => {
  const f = fixture(false); const result = await f.service.execute({ ...input(), intake: { ...intake, street1: "", city: "" } });
  expect(result.outcome).toBe("failed"); expect(result.reason_code).toBe("missing_location"); expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
 });
 it("does not create a duplicate when preferred callback belongs to another client", async () => {
  const f = fixture(); const result = await f.service.execute({ ...input(), intake: { ...intake, callback_number: "+17055550100" } });
  expect(result.outcome).toBe("failed"); expect(f.run.mock.calls.some(([q]) => q.startsWith("mutation"))).toBe(false);
 });
 it("never repeats an ambiguous write, including after service restart", async () => {
  const f = fixture(false), args = input(), orig = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (q,v) => { const r = await orig(q,v); if (q.includes("VoiceCreateRequest")) throw new Error("response lost after commit"); return r; });
  expect((await f.service.execute(args)).outcome).toBe("uncertain");
  const restarted = new VoiceService(f.journal, f.run, "williams");
  expect((await restarted.execute(args)).outcome).toBe("uncertain");
  expect(f.run.mock.calls.filter(([q]) => q.includes("VoiceCreateRequest")).length).toBe(1);
 });
 it("returns pending for concurrent duplicate submissions", async () => {
  const f = fixture(false), args = input();
  const [a,b] = await Promise.all([f.service.execute(args),f.service.execute(args)]);
  expect([a.outcome,b.outcome]).toContain("pending"); expect([a.outcome,b.outcome]).toContain("completed");
  expect(f.run.mock.calls.filter(([q]) => q.includes("VoiceCreateRequest")).length).toBe(1);
 });
 it("retains an unlinked message without requiring service intake", async () => {
  const f = fixture();const result = await f.service.execute({ action: "message",call_id:"call1",caller_number:"",operation_id:randomUUID(),confirmed:true,message:"Please call me" });
  expect(result.outcome).toBe("completed");expect(result.email_only).toBe(true);
 });
});

describe("voice status and reconciliation", () => {
 it("returns only customer-facing status and recorded windows", async()=>{
  const f=fixture(),original=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(q,v)=>q.includes("VoiceJob(")?{job:{id:"j1",title:"Repair",jobStatus:"ACTIVE",client:{id:"c1"},property:{id:"p1"},invoice:{amount:999},notes:[{message:"internal"}],jobberWebUri:"https://secure.getjobber.com/jobs/j1"}}:q.includes("VoiceVisits")?{job:{visits:conn([{id:"v1",client:{id:"c1"},property:{id:"p1"},job:{id:"j1"},startAt:null,endAt:null,instructions:"secret",assignedUsers:conn([{id:"staff"}])}])}}:original(q,v));
  const r=await f.service.execute({action:"status",call_id:"call1",caller_number:"7055550100",record_type:"job",record_id:"j1"});
  expect(r.record.appointments[0].mode).toBe("unscheduled");
  expect(JSON.stringify(r)).not.toMatch(/internal|secret|staff|invoice|999/);
 });
 it("rejects a foreign client/property job and malformed caller numbers", async()=>{
  for(const number of ["+17055550100","hidden","sip:+17055550100"]){
   const f=fixture(),original=f.run.getMockImplementation()!;
   f.run.mockImplementation(async(q,v)=>q.includes("VoiceJob(")?{job:{id:"j2",client:{id:"foreign"},property:{id:"other"}}}:original(q,v));
   await expect(f.service.execute({action:"status",call_id:"call1",caller_number:number,record_type:"job",record_id:"j2"})).rejects.toThrow();
   expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
  }
 });
 it("matches secondary client numbers",async()=>{
  const f=fixture();f.cs[0].phones.push({number:"+17055550102"});
  expect((await f.service.execute({action:"resolve",call_id:"call1",caller_number:"+17055550102"})).phone_match).toBe("matched");
 });
 it("blocks new clients when linked contact email is a duplicate",async()=>{
  const f=fixture();
  f.cs[0].contacts=[{id:"contact",name:"Other",phones:conn([]),properties:conn([]),emails:conn([{address:"alex@example.test"}])}];
  const r=await f.service.execute({...input(),intake:{...intake,email:"alex@example.test"}});
  expect(r.outcome).toBe("failed");expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
 });
 it("reconciles a lost request response and resumes only undispatched steps",async()=>{
  const f=fixture(false),original=f.run.getMockImplementation()!;const args=input();let lose=true;
  f.run.mockImplementation(async(q,v)=>{const r=await original(q,v);if(q.includes("VoiceCreateRequest")&&lose){lose=false;throw Error("lost response");}return r;});
  expect((await f.service.execute(args)).outcome).toBe("uncertain");
  const r=await f.service.execute({action:"operation_status",call_id:args.call_id,caller_number:args.caller_number,operation_id:args.operation_id});
  expect(r.outcome).toBe("completed");expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceCreateRequest")).length).toBe(1);
  expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceCreateAssessment")).length).toBe(1);
 });
 it("keeps a returned client ID and resumes after temporary readback failure",async()=>{
  const f=fixture(false),original=f.run.getMockImplementation()!;const args=input();let fail=true;
  f.run.mockImplementation(async(q,v)=>{if(q.includes("VoiceClient(")&&fail){fail=false;throw Error("read failed");}return original(q,v);});
  expect((await f.service.execute(args)).outcome).toBe("uncertain");
  expect((await f.service.execute({action:"operation_status",call_id:args.call_id,caller_number:args.caller_number,operation_id:args.operation_id})).outcome).toBe("completed");
  expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceCreateClient")).length).toBe(1);
 });
 it("does not disclose another call's operation",async()=>{
  const f=fixture(false),args=input();await f.service.execute(args);
  expect((await f.service.execute({action:"operation_status",call_id:"another-call",caller_number:args.caller_number,operation_id:args.operation_id})).outcome).toBe("not_found");
 });
});

it("preserves a multiword name without guessing a surname or country",async()=>{
 const f=fixture(false);const r=await f.service.execute({...input(),intake:{...intake,name:"Mary Ann"}});expect(r.outcome).toBe("completed");
 const c=f.run.mock.calls.find(([q])=>q.includes("VoiceCreateClient"))![1];expect(c.input.firstName).toBe("Mary Ann");expect(c.input.lastName).toBeUndefined();
 const p=f.run.mock.calls.find(([q])=>q.includes("VoiceCreateProperty"))![1];expect(p.input.properties[0].address.country).toBeUndefined();
});
it("retains incomplete street identification without creating an assessment",async()=>{
 const f=fixture(false);const r=await f.service.execute({...input(),intake:{...intake,street1:"Main Street"}});expect(r.outcome).toBe("failed");expect(r.reason_code).toBe("missing_location");expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);expect(f.run.mock.calls.some(([q])=>q.includes("VoiceCreateProperty"))).toBe(false);
});
it("requires review for duplicate addresses and ambiguous authorized properties",async()=>{
 const f=fixture();f.cs[0].properties.push({...f.cs[0].properties[0],id:"duplicate-property"});
 const r=await f.service.execute({...input(),caller_number:"+17055550100",intake:{...intake,callback_number:"+17055550100",street1:"1 Main"}});expect(r.outcome).toBe("failed");expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
 const unmatched=await f.service.execute({...input(),intake:{...intake,street1:"1 Main"}});expect(unmatched.outcome).toBe("failed");expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
});

it("confirmed message must survive stale intake arguments", async()=>{
 const f=fixture();
 const r=await f.service.execute({...input(),caller_number:"+17055550100",intake:{...intake,client_id:"c1",property_id:"p1",street1:"1 Main",callback_number:"+17055550100"}});
 expect(r.outcome).toBe("completed");
 const result=await f.service.execute({action:"message",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID(),confirmed:true,record_type:"request",record_id:"r1",message:"The new gate code is 4321",intake});
 expect(result.outcome).toBe("completed");
 expect(f.noteRecords[1].message).toContain("The new gate code is 4321");
 expect(f.noteRecords[1].message).not.toContain("Leaking tap");
});

it("concurrent reconciliation must preserve every verified outcome", async()=>{
 const f=fixture(false),original=f.run.getMockImplementation()!,args=input(); let lose=true;
 f.run.mockImplementation(async(q,v)=>{const r=await original(q,v);if(q.includes("VoiceCreateRequest")&&lose){lose=false;throw Error("lost request response");}return r;});
 expect((await f.service.execute(args)).outcome).toBe("uncertain");
 let release!:()=>void,started!:()=>void;
 const blocked=new Promise<void>(r=>{release=r}), entered=new Promise<void>(r=>{started=r});let first=true;
 f.run.mockImplementation(async(q,v)=>{if(q.includes("VoiceClientRequests")&&first){first=false;started();await blocked;}return original(q,v);});
 const status={action:"operation_status",call_id:args.call_id,caller_number:args.caller_number,operation_id:args.operation_id};
 const slow=f.service.execute(status);await entered;
 const fast=await f.service.execute(status);
 expect(fast.outcome).toBe("uncertain");
 expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceClientRequests"))).toHaveLength(1);
 release();expect((await slow).outcome).toBe("completed");
 const persisted=f.journal.get(args.operation_id,args.call_id);
 expect(persisted.records.assessment?.id).toBe("a1");expect(persisted.records.note?.id).toBe("n1");
 expect(persisted.records.assessment.url).toBe(persisted.records.request.url);
 expect(persisted.assessment_mode).toBe("unscheduled");
 expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceCreateRequest"))).toHaveLength(1);
 expect(f.run.mock.calls.filter(([q])=>q.includes("mutation VoiceRequestNote"))).toHaveLength(1);
 expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceCreateAssessment"))).toHaveLength(1);
});

it("rebuilds verified IDs and parent links after a public-result save was interrupted",async()=>{
 const f=fixture(false),args=input(),completed=await f.service.execute(args);
 f.journal.save(args.operation_id,{...completed,outcome:"uncertain",records:{client:completed.records.client,property:completed.records.property}});
 const r=await f.service.execute({action:"operation_status",call_id:args.call_id,caller_number:args.caller_number,operation_id:args.operation_id});
 expect(r.outcome).toBe("completed");expect(r.records.request.id).toBe("r1");expect(r.records.note.id).toBe("n1");expect(r.records.assessment.id).toBe("a1");
 expect(r.records.assessment.url).toBe(r.records.request.url);expect(r.assessment_mode).toBe("unscheduled");
 expect(f.run.mock.calls.filter(([q])=>q.startsWith("mutation"))).toHaveLength(5);
});

it("does not mark a mutation dispatched when budget admission rejects it before network dispatch",async()=>{
 const {BudgetUnavailableError}=await import("../../jobber/cost-governor.js");
 const f=fixture(false),args=input(),original=f.run.getMockImplementation()!;let first=true;
 f.run.mockImplementation(async(q,v)=>{if(q.includes("VoiceCreateClient")&&first){first=false;throw new BudgetUnavailableError(10);}return original(q,v);});
 expect((await f.service.execute(args)).outcome).toBe("pending");expect(f.journal.step(args.operation_id,"client")).toBeUndefined();
 expect((await f.service.execute(args)).outcome).toBe("completed");expect(f.cs.length).toBe(1);
});

it("completed slow resolve must become observable by polling", async()=>{
 vi.useFakeTimers();
 try {
  const f=fixture(), original=f.run.getMockImplementation()!;
  f.journal.addDirectoryPhone("williams","gen","+17055550100","c1");f.journal.publishDirectory("williams","gen");
  f.run.mockImplementation(async(q,v)=>{if(q.includes("VoiceClientJobs"))await new Promise(r=>setTimeout(r,2500));return original(q,v);});
  const args={action:"resolve",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID()};
  let work=f.service.dispatch(args);await vi.advanceTimersByTimeAsync(2000);expect((await work).outcome).toBe("pending");
  await vi.advanceTimersByTimeAsync(501);expect(f.journal.get(args.operation_id,args.call_id).outcome).toBe("completed");
  const observations=[];
  for(let n=0;n<3;n++){
   work=f.service.dispatch({...args,action:"operation_status"});await vi.advanceTimersByTimeAsync(2000);observations.push((await work).outcome);await vi.advanceTimersByTimeAsync(501);
  }
  expect(observations).toContain("completed");
 }finally{vi.useRealTimers();}
});
it("explicit mutation validation rejection must settle for correction",async()=>{
 const f=fixture(false),original=f.run.getMockImplementation()!;
 f.run.mockImplementation(async(q,v)=>q.includes("VoiceCreateClient")?{clientCreate:{client:null,userErrors:[{message:"First name is too long",path:["input","firstName"]}]}}:original(q,v));
 const args=input();const first=await f.service.execute(args);
 const next=await f.service.execute({action:"operation_status",call_id:args.call_id,caller_number:args.caller_number,operation_id:args.operation_id});
 expect({first:first.outcome,next:next.outcome}).toEqual({first:"failed",next:"failed"});
});
it("account verification failure must appear in index health",async()=>{
 const f=fixture();f.journal.publishDirectory("williams","gen");
 f.run.mockRejectedValue(new Error("OAuth unavailable"));
 await expect(f.service.directory.refresh()).rejects.toThrow("OAuth unavailable");
 expect(f.service.directory.status().last_failure_at).not.toBeNull();
});
it("invalid email is rejected before connector journal",async()=>{
 const f=fixture(false),app=new Hono(),key="x".repeat(40);registerVoiceRoutes(app,f.service,key);
 const args={...input(),intake:{...intake,email:"not-an-email"}};
 const response=await app.request("/voice/v1/execute",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(args)});
 expect(response.status).toBe(422);const value=await response.json();expect(value.outcome).toBe("failed");expect(value.reason_code).toBe("invalid_input");expect(value.submission_rejected).toBe(true);expect(()=>f.journal.get(args.operation_id,args.call_id)).toThrow("not found");
});

it("reauthorizes completed reads and blocks revoked phone access",async()=>{
 const f=fixture();f.journal.addDirectoryPhone("williams","gen","+17055550100","c1");f.journal.publishDirectory("williams","gen");
 const args={action:"resolve",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID()};
 expect((await f.service.dispatch(args)).phone_match).toBe("matched");
 f.cs[0].phones=[];
 const r=await f.service.dispatch({...args,action:"operation_status"});expect(r.outcome).toBe("failed");expect(r.records).toEqual({});
 expect(f.journal.get(args.operation_id,args.call_id).outcome).toBe("completed");
});
it("slow status reauthorization is consumed without restarting after every poll",async()=>{
 vi.useFakeTimers();
 try{
  const f=fixture(),original=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(q,v)=>q.includes("VoiceJob(")?{job:{id:"j1",title:"Repair",jobStatus:"ACTIVE",client:{id:"c1"},property:{id:"p1"}}}:q.includes("VoiceVisits")?(await new Promise(r=>setTimeout(r,2500)),{job:{visits:conn([])}}):original(q,v));
  const args={action:"status",record_type:"job",record_id:"j1",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID()};
  let work=f.service.dispatch(args);await vi.advanceTimersByTimeAsync(2000);expect((await work).outcome).toBe("pending");await vi.advanceTimersByTimeAsync(501);
  work=f.service.dispatch({...args,action:"operation_status"});await vi.advanceTimersByTimeAsync(2000);const pending=await work;expect(pending.outcome).toBe("pending");expect(pending.reason_code).toBe("authorization_refresh");
  await vi.advanceTimersByTimeAsync(501);
  const completed=await f.service.dispatch({...args,action:"operation_status"});expect(completed.outcome).toBe("completed");expect(completed.record.title).toBe("Repair");
  expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceVisits"))).toHaveLength(2);
 }finally{vi.useRealTimers();}
});
it("drops expired authorization handoffs and rechecks phone access",async()=>{
 vi.useFakeTimers();
 try{
  const f=fixture(),original=f.run.getMockImplementation()!;
  let slow=false;
  f.journal.addDirectoryPhone("williams","gen","+17055550100","c1");f.journal.publishDirectory("williams","gen");
  f.run.mockImplementation(async(q,v)=>{if(slow && q.includes("VoiceClient("))await new Promise(r=>setTimeout(r,1100));return original(q,v);});
  const args={action:"resolve",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID()};await f.service.dispatch(args);slow=true;
  const work=f.service.dispatch({...args,action:"operation_status"});await vi.advanceTimersByTimeAsync(2000);expect((await work).outcome).toBe("pending");await vi.advanceTimersByTimeAsync(2301);
  slow=false;f.cs[0].phones=[];
  expect((await f.service.dispatch({...args,action:"operation_status"})).outcome).toBe("failed");
 }finally{vi.useRealTimers();}
});
it("a rejected step survives a crash before the final outcome save",async()=>{
 const f=fixture(false),original=f.run.getMockImplementation()!;
 f.run.mockImplementation(async(q,v)=>q.includes("VoiceCreateClient")?{clientCreate:{client:null,userErrors:[{message:"Name rejected",path:["input","firstName"]}]}}:original(q,v));
 const args=input();const failed=await f.service.execute(args);expect(failed.validation_errors[0].message).toBe("Name rejected");expect(f.journal.step(args.operation_id,"client")?.state).toBe("rejected");
 f.journal.save(args.operation_id,{operation_id:args.operation_id,outcome:"pending",records:{}});
 const restarted=new VoiceService(f.journal,f.run,"williams");const r=await restarted.dispatch(args);expect(r.outcome).toBe("failed");expect(r.reason_code).toBe("jobber_validation");expect(r.validation_errors[0].path).toEqual(["input","firstName"]);
 expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceCreateClient"))).toHaveLength(1);
});
it("an invalid payload under an existing operation ID cannot authorize a new corrected workflow",async()=>{
 const f=fixture(false),args=input();await f.service.execute(args);
 const app=new Hono(),key="x".repeat(40);registerVoiceRoutes(app,f.service,key);
 const r=await app.request("/voice/v1/execute",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({...args,intake:{...intake,email:"invalid"}})});
 expect((await r.json()).submission_rejected).toBe(false);expect(f.journal.get(args.operation_id,args.call_id).outcome).toBe("completed");
});
it("refreshes property restrictions and record ownership before delivering resolve",async()=>{
 const f=fixture(),original=f.run.getMockImplementation()!;f.cs[0].phones=[];
 let allowed="p1",owner="c1";
 const job=()=>({id:"j1",title:"Private repair",client:{id:owner},property:{id:"p1"}});
 f.run.mockImplementation(async(q,v)=>q.includes("VoiceContacts")?{client:{contacts:conn([{id:"contact",phones:conn([{number:"+17055550100"}]),properties:conn([{id:allowed}])}])}}:q.includes("VoiceClientJobs")?{client:{jobs:conn([job()])}}:q.includes("VoiceJob(")?{job:job()}:original(q,v));
 f.journal.addDirectoryPhone("williams","gen","+17055550100","c1");f.journal.publishDirectory("williams","gen");
 const args={action:"resolve",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID()};
 expect((await f.service.dispatch(args)).records[0].jobs).toHaveLength(1);
 allowed="p2";expect((await f.service.dispatch({...args,action:"operation_status"})).records[0].jobs).toEqual([]);
 allowed="p1";owner="other-client";expect((await f.service.dispatch({...args,action:"operation_status"})).records[0].jobs).toEqual([]);
});

it("retains uncertainty for top-level execution errors merged into mutation data",async()=>{
 const clientModule=await import("../../jobber/client.js");
 const merged=vi.spyOn(clientModule,"hasMutationExecutionErrors").mockReturnValue(true);
 try{
  const f=fixture(false),original=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(q,v)=>q.includes("VoiceCreateClient")?{clientCreate:{client:null,userErrors:[{message:"Execution failed",path:["clientCreate"]}]}}:original(q,v));
  const args=input();expect((await f.service.execute(args)).outcome).toBe("uncertain");expect(f.journal.step(args.operation_id,"client")?.state).toBe("dispatched");
 }finally{merged.mockRestore();}
});


describe("revision-bound preflight and recovery",()=>{
 it("invalidates cached preflight choices when their phone authorization is removed",async()=>{
  const f=fixture();f.journal.addDirectoryPhone("williams","gen","+17055550100","c1");f.journal.publishDirectory("williams","gen");
  const args={action:"preflight",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID(),intake};
  expect((await f.service.dispatch(args)).choices[0].name).toBe("Jane Doe");f.cs[0].phones=[];
  const r=await f.service.dispatch({action:"operation_status",call_id:args.call_id,caller_number:args.caller_number,operation_id:args.operation_id});
  expect(r).toMatchObject({outcome:"failed",reason_code:"authorization_changed",next_action:"staff_review",preflight_state:"staff_review",choices:[]});expect(JSON.stringify(r)).not.toContain("Jane Doe");expect(JSON.stringify(f.journal.get(args.operation_id,args.call_id))).not.toContain("1 Main");
 });
 it("invalidates a ready receipt if the selected property is removed before a later disclosure",async()=>{
  const f=fixture();const args={action:"preflight",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID(),intake:{...intake,client_id:"c1",property_id:"p1",street1:"1 Main"}};
  expect((await f.service.dispatch(args)).preflight_state).toBe("ready");f.cs[0].properties=[];
  const r=await f.service.dispatch(args);expect(r).toMatchObject({outcome:"failed",reason_code:"authorization_changed"});expect(r.destination).toBeUndefined();
  const submitted=await f.service.dispatch({...input(),caller_number:args.caller_number,workflow_version:2,preflight_id:args.operation_id,intake:args.intake});expect(submitted.reason_code).toBe("preflight_changed");expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
 });
 it("offers shared-number selection without scanning unrelated clients, then submits only the explicit destination",async()=>{
  const f=fixture();f.cs.push({...structuredClone(f.cs[0]),id:"c2",name:"Other",properties:[{id:"p2",street1:"2 Main",street2:"",city:"Englehart"}]});
  for(const c of f.cs)f.journal.addDirectoryPhone("williams","gen","+17055550100",c.id);f.journal.publishDirectory("williams","gen");
  const original=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(q,v)=>{if(q.includes("VoiceClients(") || q.includes("VoiceCensus"))throw Error("Full account scan must not run");return original(q,v)});
  const args={action:"preflight",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID(),intake:{...intake,callback_number:"+17055550100"}};
  const r=await f.service.dispatch(args);expect(r).toMatchObject({outcome:"completed",preflight_state:"selection_required",next_action:"select_client"});expect(r.choices).toHaveLength(2);
  const chosen={...args,operation_id:randomUUID(),intake:{...args.intake,client_id:"c2",property_id:"p2"}};
  expect((await f.service.dispatch(chosen)).preflight_state).toBe("ready");
  const written=await f.service.dispatch({...input(),caller_number:args.caller_number,intake:chosen.intake,workflow_version:2,preflight_id:chosen.operation_id});
  expect(written.outcome).toBe("completed");expect(f.requests[0].client.id).toBe("c2");expect(f.requests[0].property.id).toBe("p2");
 });
 it("selects an explicitly confirmed authorized destination among shared-number clients",async()=>{
  const f=fixture();f.cs.push({...structuredClone(f.cs[0]),id:"c2",name:"Alex",properties:[{id:"p2",street1:"2 Main Street",street2:"",city:"Englehart"}]});
  const pf={action:"preflight",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID(),intake:{...intake,client_id:"c2",callback_number:"+17055550100",street1:" 2 MAIN st. "}};
  const r=await f.service.dispatch(pf);expect(r.preflight_state).toBe("ready");expect(r.destination.client_id).toBe("c2");expect(r.destination.property_id).toBe("p2");
  const submitted=await f.service.dispatch({...input(),caller_number:pf.caller_number,workflow_version:2,preflight_id:pf.operation_id,intake:pf.intake});expect(submitted.outcome).toBe("completed");
  expect(f.run.mock.calls.find(([q])=>q.includes("VoiceCreateRequest"))![1].input.propertyId).toBe("p2");
 });
 it("does not choose the first indistinguishable shared-number record",async()=>{
  const f=fixture();f.cs[0].name="Alex";f.cs.push({...structuredClone(f.cs[0]),id:"c2"});
  for(const c of f.cs)f.journal.addDirectoryPhone("williams","gen","+17055550100",c.id);f.journal.publishDirectory("williams","gen");
  const r=await f.service.dispatch({action:"preflight",call_id:"call1",caller_number:"+17055550100",operation_id:randomUUID(),intake:{...intake,street1:"1 Main"}});
  expect(r.preflight_state).toBe("staff_review");expect(r.reason_code).toBe("indistinguishable_clients");expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
 });
 it("rejects changed intake under a ready preflight without dispatch",async()=>{
  const f=fixture(false);const id=randomUUID();await f.service.dispatch({action:"preflight",call_id:"call1",caller_number:"+17055550101",operation_id:id,intake});
  const r=await f.service.dispatch({...input(),workflow_version:2,preflight_id:id,intake:{...intake,description:"different"}});
  expect(r.reason_code).toBe("preflight_changed");expect(r.safe_to_reconfirm).toBe(true);expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
 });
 it("requires explicit on-site intent; omission creates no Assessment",async()=>{
  const f=fixture(false);const noAssessment={...intake};delete (noAssessment as any).assessment;const r=await f.service.execute({...input(),intake:noAssessment});
  expect(r.outcome).toBe("completed");expect(r.assessment_mode).toBe("not_created");expect(f.run.mock.calls.some(([q])=>q.includes("VoiceCreateAssessment"))).toBe(false);
 });
 it("does not append a resumed note or assessment after the Request property moved",async()=>{
  const f=fixture(false),args=input();const original=f.run.getMockImplementation()!;let fail=true;
  f.run.mockImplementation(async(q,v)=>{if(q.includes("VoiceRequestNotes") && fail)throw Error("readback lost");return original(q,v)});
  expect((await f.service.execute(args)).outcome).toBe("uncertain");f.requests[0].property={id:"moved-property"};fail=false;
  const r=await f.service.execute({action:"operation_status",call_id:args.call_id,caller_number:args.caller_number,operation_id:args.operation_id});
  expect(r.outcome).toBe("uncertain");expect(f.run.mock.calls.some(([q])=>q.includes("VoiceCreateAssessment"))).toBe(false);
 });
 it("completed duplicate scans are refreshed before a later creation decision",async()=>{
  const f=fixture(false),pf={action:"preflight",call_id:"call1",caller_number:"+17055550101",operation_id:randomUUID(),intake};
  expect((await f.service.dispatch(pf)).preflight_state).toBe("ready");
  f.cs.push({...structuredClone(client),phones:[],properties:[],name:"Alex"});
  const r=await f.service.dispatch({...input(),workflow_version:2,preflight_id:pf.operation_id});
  expect(r.reason_code).toBe("potential_duplicate");expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
 });
 it("uses a complete recent metadata generation as baseline but catches changed contacts in live pages",async()=>{
  const f=fixture();f.cs[0].contacts=[];await f.service.directory.refresh();
  f.run.mockClear();
  f.cs[0].contacts=[{id:"new-contact",name:"Other",phones:conn([]),properties:conn([]),emails:conn([{address:"alex@example.test"}])}];
  const r=await f.service.dispatch({action:"preflight",call_id:"call1",caller_number:"+17055550101",operation_id:randomUUID(),intake:{...intake,email:"alex@example.test"}});
  expect(r).toMatchObject({preflight_state:"staff_review",reason_code:"potential_duplicate"});expect(f.run.mock.calls.some(([q])=>q.startsWith("mutation"))).toBe(false);
  expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceCensusClients"))).toHaveLength(1);
 });
 it("does not reuse an old completed census as evidence that a client is new",async()=>{
  const f=fixture(false);await f.service.directory.refresh();
  const metadata=f.journal.checkpoint("directory-metadata:williams");metadata.completed_at=Date.now()-300001;f.journal.setCheckpoint("directory-metadata:williams",metadata);f.run.mockClear();
  const r=await f.service.dispatch({action:"preflight",call_id:"call1",caller_number:"+17055550101",operation_id:randomUUID(),intake});
  expect(r.preflight_state).toBe("ready");expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceCensusClients"))).toHaveLength(2);
 });
 it("a read-only preflight interrupted by hangup fails clearly without pretending a selection is needed",async()=>{
  const f=fixture(false),original=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(q,v)=>{const r=await original(q,v);if(q.includes("VoiceCensusClients"))f.journal.setCheckpoint("ended-call:call1",{ended_at:Date.now()});return r;});
  const r=await f.service.dispatch({action:"preflight",call_id:"call1",caller_number:"+17055550101",operation_id:randomUUID(),intake});
  expect(r).toMatchObject({outcome:"failed",reason_code:"call_ended",next_action:"none"});expect(r.preflight_state).toBeUndefined();
 });
 it("a slow new-client scan cannot block an unrelated authorized note",async()=>{
  const f=fixture();
  await f.service.execute({...input(),caller_number:"+17055550100",intake:{...intake,client_id:"c1",property_id:"p1",street1:"1 Main"}});
  const original=f.run.getMockImplementation()!;let release!:(value:any)=>void;let blocked=false;
  f.run.mockImplementation(async(q,v)=>{if(q.includes("VoiceClients(") && !blocked){blocked=true;return await new Promise(r=>{release=r})}return original(q,v)});
  const slow=f.service.execute(input());for(let i=0;i<10&&!release;i++)await Promise.resolve();
  const note=await f.service.execute({action:"message",call_id:"other",caller_number:"+17055550100",operation_id:randomUUID(),confirmed:true,record_type:"request",record_id:"r1",message:"Call tomorrow"});
  expect(note.outcome).toBe("completed");release({clients:conn([])});await slow;
 });
});

it("serializes the final new-client decision after concurrent discovery",async()=>{
 const f=fixture(false);
 const results=await Promise.all([f.service.dispatch(input()),f.service.dispatch({...input(),call_id:"call2"})]);
 expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceCreateClient")).length).toBe(1);
 expect(results.some(r=>r.outcome==="completed")).toBe(true);
});
it("leases exclude in-flight work and retries back off without starving new work",()=>{
 const f=fixture(false),ids=Array.from({length:12},()=>randomUUID());
 for(const id of ids)f.journal.start(id,"call",{id});
 expect(f.journal.claim(ids[0])).toBe(true);expect(f.journal.claim(ids[0])).toBe(false);
 expect(f.journal.pending().some(o=>o.id===ids[0])).toBe(false);
 f.journal.release(ids[0]);expect(f.journal.pending()[0].id).toBe(ids[1]);
 let previous=0;
 for(let attempt=0;attempt<8;attempt++){
  f.journal.claim(ids[0]);const delay=f.journal.retryAt(ids[0])-Date.now();f.journal.release(ids[0]);
  expect(delay).toBeGreaterThanOrEqual(previous-1);expect(delay).toBeLessThanOrEqual(300000);previous=delay;
 }
});
