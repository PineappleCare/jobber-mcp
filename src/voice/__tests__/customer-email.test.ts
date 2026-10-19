import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {VoiceJournal} from "../journal.js";
import {VoiceService} from "../service.js";
import {appointment,customerStatus} from "../customer.js";
vi.mock("../../utils/auditLog.js",()=>({appendAuditLog:vi.fn()}));
const conn=(nodes:any[])=>({nodes,pageInfo:{hasNextPage:false,endCursor:null}});
const resources:{dir:string;journal:VoiceJournal}[]=[];
function setup(contactOnly=false) {
 const dir=mkdtempSync(path.join(os.tmpdir(),"voice-email-")),journal=new VoiceJournal(path.join(dir,"journal.db"));resources.push({dir,journal});
 const contacts=[{id:"ct",name:"Tenant",isBillingContact:false,phones:conn([{number:"7055550100",primary:true}]),properties:conn([{id:"p1"}]),emails:conn([{id:"ce",address:"tenant@old.test",primary:true}])},{id:"other",name:"Other",isBillingContact:true,phones:conn([]),properties:conn([{id:"p2"}]),emails:conn([])}];
 const client:any={id:"c",name:"Company",phones:[{id:"phone",number:"7055550100",primary:true,contact:contactOnly ? {id:"ct"}:null}],emails:[{id:"e",address:"old@example.test",primary:true,contact:null},{id:"ce",address:"tenant@old.test",primary:true,contact:{id:"ct"}}],properties:[{id:"p1",street1:"1 Main",city:"Englehart"},{id:"p2",street1:"2 Main",city:"Englehart"}],jobberWebUri:"https://secure.getjobber.com/clients/c"};
 let lost=false;
 const visits:any[]=[];
 const run=vi.fn(async(q:string,v:any={})=>{
  if(q.includes("VoiceAccount"))return {account:{id:"williams"}};
  if(q.includes("VoiceClient("))return {client:v.id==="c" ? client:null};
  if(q.includes("VoiceContacts") || q.includes("VoiceEmailContacts"))return {client:{contacts:conn(contacts)}};
  if(q.includes("VoiceEditEmail")) {
   const edit=v.input.contactsToEdit?.[0] || v.input;
   const emails=v.input.contactsToEdit ? contacts.find(c=>c.id===edit.id)!.emails.nodes:client.emails;
   if(edit.emailsToAdd) {const e=edit.emailsToAdd[0];if(e.primary)for(const old of emails)if(!old.contact?.id)old.primary=false;emails.push({id:"added",...e,contact:null});}
   if(edit.emailsToEdit) {for(const e of emails)if(!e.contact?.id)e.primary=e.id===edit.emailsToEdit[0].id;}
   if(lost)throw new Error("lost after write");
   return {clientEdit:{client,userErrors:[]}};
  }
  if(q.includes("VoiceJob("))return {job:{id:"j",title:"Repair",jobStatus:"requires_invoicing",client:{id:"c"},property:{id:"p1"},notes:[{message:"secret"}],lineItems:[{price:123}]}};
  if(q.includes("VoiceVisits"))return {job:{visits:conn(visits)}};
  throw new Error(q);
 });
 return {journal,client,contacts,visits,run,service:new VoiceService(journal,run,"williams"),lose:()=>{lost=true;}};
}
const base={call_id:"call",caller_number:"7055550100"};
async function proposal(f:ReturnType<typeof setup>,email_update:any) {
 const prepared=await f.service.execute({...base,action:"email_prepare",email_update});
 return {...base,action:"contact_email",operation_id:randomUUID(),confirmed:true,email_update,email_fingerprint:prepared.email_fingerprint};
}
afterEach(()=>resources.splice(0).forEach(r=>{r.journal.close();rmSync(r.dir,{recursive:true,force:true});}));
describe("customer email writes",()=>{
 it("appends without erasing existing emails or changing their preference",async()=>{
  const f=setup(),args=await proposal(f,{client_id:"c",address:"new@example.test"});
  const result=await f.service.execute(args);expect(result.outcome).toBe("completed");expect(result.email_update.primary).toBe(false);
  expect(f.client.emails.map((e:any)=>e.address)).toContain("old@example.test");
  const input=f.run.mock.calls.find(([q])=>q.includes("VoiceEditEmail"))![1].input;
  expect(input).toEqual({emailsToAdd:[{address:"new@example.test",primary:false}]});
  expect((await f.service.execute(args)).outcome).toBe("completed");expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceEditEmail"))).toHaveLength(1);
 });
 it("only changes primary when expressly requested",async()=>{
  const f=setup(),args=await proposal(f,{client_id:"c",address:"OLD@EXAMPLE.TEST",make_primary:true});
  expect((await f.service.execute(args)).email_update.already_present).toBe(true);
  expect(f.run.mock.calls.some(([q])=>q.includes("VoiceEditEmail"))).toBe(false);
  const next=await proposal(f,{client_id:"c",address:"new@example.test",make_primary:true});
  expect((await f.service.execute(next)).email_update.primary).toBe(true);expect(f.client.emails.find((e:any)=>e.id==="e").primary).toBe(false);
 });
 it("rejects contact-owned phone escalation but permits that contact's email",async()=>{
  const f=setup(true);
  for(const change of [{client_id:"c",address:"new@example.test"},{client_id:"c",contact_id:"other",address:"new@example.test"}])await expect(f.service.execute({...base,action:"email_prepare",email_update:change})).rejects.toThrow("Contact phone");
  const args=await proposal(f,{client_id:"c",contact_id:"ct",address:"new@example.test",intended_use:"invoices"});
  const result=await f.service.execute(args);expect(result.outcome).toBe("completed");expect(result.email_update.invoice_followup).toBe(true);
  expect(f.run.mock.calls.find(([q])=>q.includes("VoiceEditEmail"))![1].input).toEqual({contactsToEdit:[{id:"ct",emailsToAdd:[{address:"new@example.test",primary:false}]}]});
 });
 it("refuses stale proposals before mutation",async()=>{
  const f=setup(),args=await proposal(f,{client_id:"c",address:"new@example.test"});f.client.emails.push({id:"staff",address:"staff@example.test",primary:false,contact:null});
  expect((await f.service.execute(args)).reason_code).toBe("email_changed");expect(f.run.mock.calls.some(([q])=>q.includes("VoiceEditEmail"))).toBe(false);
 });
 it("reconciles a lost mutation response after restart without appending twice",async()=>{
  const f=setup(),args=await proposal(f,{client_id:"c",address:"new@example.test"});f.lose();
  expect((await f.service.execute(args)).outcome).toBe("uncertain");
  const restarted=new VoiceService(f.journal,f.run,"williams");
  const result=await restarted.execute({...base,action:"operation_status",operation_id:args.operation_id});expect(result.outcome).toBe("completed");expect(f.run.mock.calls.filter(([q])=>q.includes("VoiceEditEmail"))).toHaveLength(1);
 });
 it("keeps uncertain state when readback finds a removed prior address",async()=>{
  const f=setup(),args=await proposal(f,{client_id:"c",address:"new@example.test"});f.lose();await f.service.execute(args);f.client.emails=f.client.emails.filter((e:any)=>e.id!=="e");
  expect((await f.service.execute({...base,action:"operation_status",operation_id:args.operation_id})).outcome).toBe("uncertain");
 });
 it("makes first-email preference explicit before confirmation",async()=>{
  const f=setup();f.client.emails=[];const r=await f.service.execute({...base,action:"email_prepare",email_update:{client_id:"c",address:"new@example.test"}});expect(r.will_be_primary).toBe(true);expect(r.make_primary).toBe(false);
 });
});
describe("customer schedule projection",()=>{
 it("rejects disclosure when contact restrictions change during visit loading",async()=>{
  const f=setup(true);
  const original=f.run.getMockImplementation()!;
  f.run.mockImplementation(async(q,v)=>{const result=await original(q,v);if(q.includes("VoiceVisits"))f.contacts[0].properties=conn([{id:"p1"},{id:"p2"}]);return result;});
  await expect(f.service.execute({...base,action:"status",record_type:"job",record_id:"j"})).rejects.toThrow("Phone access changed");
 });
 it("filters completed and unauthorized visits and excludes financial states",async()=>{
  const f=setup(true);f.visits.push(...["p1","p2"].map((id,i)=>({id:`v${i}`,client:{id:"c"},property:{id},job:{id:"j"},startAt:null,endAt:null,isComplete:false})),{id:"done",client:{id:"c"},property:{id:"p1"},job:{id:"j"},startAt:"2026-10-01T12:00:00Z",endAt:"2026-10-01T13:00:00Z",isComplete:true});
  const r=await f.service.execute({...base,action:"status",record_type:"job",record_id:"j"});expect(r.record.title).toBe("Repair");expect(r.record.status).toBe("status unavailable");expect(r.record.appointments).toHaveLength(1);expect(r.record.appointments[0].mode).toBe("unscheduled");expect(r.record.customer.contact_details[0].name).toBe("Tenant");expect(JSON.stringify(r)).not.toMatch(/secret|lineItems|123|requires_invoicing|2 Main|old@example/);
  const history=await f.service.execute({...base,action:"status",record_type:"job",record_id:"j",include_history:true});expect(history.record.appointments).toHaveLength(2);
 });
 it("does not invent arrival windows or turn missing dates into unscheduled",()=>{
  expect(appointment({startAt:undefined,endAt:undefined}).mode).toBe("unknown");
  expect(appointment({startAt:"2026-10-10T00:00:00Z",endAt:null,allDay:true})).toMatchObject({mode:"date_only",arrival_window:null,end_at:null});
  expect(appointment({startAt:"2026-10-10T12:00:00Z",endAt:"2026-10-10T13:00:00Z",allDay:true})).toMatchObject({mode:"date_only",arrival_window:null,end_at:null});
  expect(appointment({startAt:"2026-10-10T12:00:00Z",endAt:"2026-10-10T13:00:00Z"}).arrival_window).toBeNull();expect(customerStatus("LATE")).toBe("status unavailable");
 });
});
