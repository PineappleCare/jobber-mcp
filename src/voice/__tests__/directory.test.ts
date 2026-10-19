import { describe,it,expect,vi,afterEach } from "vitest";
import { mkdtempSync,rmSync } from "node:fs";
import os from "node:os";import path from "node:path";import {randomUUID} from "node:crypto";
import {VoiceJournal} from "../journal.js";import {VoiceService} from "../service.js";
const dirs:string[]=[],journals:VoiceJournal[]=[];
const conn=(nodes:any[],hasNextPage=false,endCursor:string|null=null)=>({nodes,pageInfo:{hasNextPage,endCursor}});
function journal(){const dir=mkdtempSync(path.join(os.tmpdir(),"voice-directory-"));dirs.push(dir);const j=new VoiceJournal(path.join(dir,"journal.db"));journals.push(j);return j;}
afterEach(()=>{vi.useRealTimers();journals.splice(0).forEach(j=>j.close());dirs.splice(0).forEach(d=>rmSync(d,{force:true,recursive:true}));});
describe("durable directory",()=>{
 it("publishes only complete generations and resumes the contact cursor after restart",async()=>{
  const j=journal();let fail=true;
  const run=vi.fn(async(q:string,v:any={})=>{
   if(q.includes("VoiceAccount"))return {account:{id:"williams"}};
   if(q.includes("VoiceCensusClients"))return {clients:conn([{id:"c1",phones:[{number:"7055550100"},{number:"7055550102"}],contacts:conn([{id:"ct1",phones:conn([{number:"7055550103"}]),emails:conn([]),properties:conn([])}],true,"ct1")}])};
   expect(q).toContain("includePropertyContacts:true");
   if(v.after==="ct1"){if(fail)throw Error("connection lost");return {client:{contacts:conn([{id:"ct2",phones:conn([{number:"7055550104"}]),emails:conn([]),properties:conn([])}])}};}
   return {client:{contacts:conn([{id:"ct1",phones:conn([{number:"7055550103"}]),emails:conn([]),properties:conn([])}],true,"ct1")}};
  });
  const first=new VoiceService(j,run,"williams");
  await expect(first.directory.refresh()).rejects.toThrow("connection lost");expect(first.directory.candidates("+17055550103")).toBeUndefined();expect(first.directory.status().last_failure_at).not.toBeNull();
  expect(first.directory.status()).toMatchObject({last_failure_stage:"census",last_failure_reason:"read_unavailable",refresh_clients:0,refresh_contacts_completed:0});
  expect(JSON.stringify(first.directory.status())).not.toContain("connection lost");
  fail=false;const restarted=new VoiceService(j,run,"williams");await restarted.directory.refresh();
  expect(run.mock.calls.filter(([q])=>q.includes("VoiceCensusClients")).length).toBe(1);
  for(const n of ["0100","0102","0103","0104"])expect(restarted.directory.candidates(`+1705555${n}`)).toEqual(["c1"]);
  expect(restarted.directory.status().complete).toBe(true);
 });
 it("rechecks indexed candidates and rejects deleted phone authorization",async()=>{
  const j=journal();j.addDirectoryPhone("williams","gen","+17055550100","c1");j.publishDirectory("williams","gen");
  const run=vi.fn(async(q:string)=>{
   if(q.includes("VoiceAccount"))return {account:{id:"williams"}};
   if(q.includes("VoiceClient("))return {client:{id:"c1",phones:[],properties:[]}};
   if(q.includes("VoiceContacts"))return {client:{contacts:conn([])}};
   throw Error("unexpected query");
  });
  const s=new VoiceService(j,run,"williams");const result=await s.dispatch({action:"resolve",call_id:"call",caller_number:"+17055550100",operation_id:randomUUID()});
  expect(result.phone_match).toBe("unresolved");expect(result.records).toEqual([]);
 });
 it("returns pending within the voice deadline while a census continues",async()=>{
  vi.useFakeTimers();const j=journal();let release!:(x:any)=>void;let reads=0;
  const run=vi.fn(async(q:string)=>{if(q.includes("VoiceAccount"))return {account:{id:"williams"}};if(reads++===0)return await new Promise(r=>{release=r});return {clients:conn([])};});
  const s=new VoiceService(j,run,"williams");const args={action:"preflight",call_id:"call",caller_number:"+17055550100",operation_id:randomUUID(),intake:{name:"New",callback_number:"+17055550100",description:"Tap",service:"Plumbing",street1:"1 Main",city:"Englehart"}};
  const pending=s.dispatch(args);await vi.advanceTimersByTimeAsync(2000);expect((await pending).outcome).toBe("pending");
  release({clients:conn([])});await vi.advanceTimersByTimeAsync(1);
  expect(j.get(args.operation_id,args.call_id).preflight_state).toBe("ready");
 });
 it("resumes complete census pages after a temporary failure instead of restarting",async()=>{
  const j=journal();let fail=true;
  const run=vi.fn(async(q:string,v:any={})=>{
   if(q.includes("VoiceAccount"))return {account:{id:"williams"}};
   if(q.includes("VoiceCensusClients")){if(v.after==="next" && fail)throw Error("THROTTLED");return {clients:conn([],!v.after,v.after?null:"next")};}
   throw Error("unexpected");
  });
  const args={action:"preflight",call_id:"call",caller_number:"+17055550100",operation_id:randomUUID(),intake:{name:"New",callback_number:"+17055550100",description:"Tap",service:"Plumbing",street1:"1 Main",city:"Englehart"}};
  const s=new VoiceService(j,run,"williams");expect((await s.dispatch(args)).outcome).toBe("pending");fail=false;
  const restarted=new VoiceService(j,run,"williams");
  expect((await restarted.dispatch(args)).outcome).toBe("pending");
  const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+16000);
  try {expect((await restarted.dispatch(args)).preflight_state).toBe("ready");}finally{clock.mockRestore();}
  // Exactly one first page for each of the two passes, not a third after retry.
  expect(run.mock.calls.filter(([q,v])=>q.includes("VoiceCensusClients")&&!v.after).length).toBe(2);
 });
});

it("does not extend a call's read deadline on repeated disconnect signals",async()=>{
 const j=journal(),s=new VoiceService(j,async()=>({}),"williams");
 await s.dispatch({action:"end_call",call_id:"call",caller_number:"+17055550100"});
 const ended=j.checkpoint("ended-call:call").ended_at;
 const clock=vi.spyOn(Date,"now").mockReturnValue(ended+31000);
 try {await s.dispatch({action:"end_call",call_id:"call",caller_number:"+17055550100"});expect(j.checkpoint("ended-call:call").ended_at).toBe(ended);}finally{clock.mockRestore();}
});

it("fully indexes more than a thousand clients without doing a full scan for a matched caller",async()=>{
 const j=journal();const clients=Array.from({length:1101},(_,i)=>({id:`c${i}`,phones:[{number:`+1705${String(i).padStart(7,"0")}`}]}));
 const run=vi.fn(async(q:string,v:any={})=>{
  if(q.includes("VoiceAccount"))return {account:{id:"williams"}};
  if(q.includes("VoiceCensusClients")){const start=Number(v.after||0),end=Math.min(start+20,clients.length);return {clients:conn(clients.slice(start,end).map(c=>({...c,contacts:conn([])})),end<clients.length,end<clients.length?String(end):null)};}
  if(q.includes("VoiceIndexContacts")||q.includes("VoiceContacts"))return {client:{contacts:conn([])}};
  if(q.includes("VoiceClient("))return {client:{...clients[1100],name:"Authorized",properties:[]}};
  if(q.includes("VoiceClientRequests"))return {client:{requests:conn([])}};
  if(q.includes("VoiceClientJobs"))return {client:{jobs:conn([])}};
  throw Error("unexpected full scan");
 });
 const s=new VoiceService(j,run,"williams");await s.directory.refresh();expect(run.mock.calls.filter(([q])=>q.includes("VoiceCensusClients")).length).toBe(56);
 const r=await s.dispatch({action:"resolve",call_id:"call",caller_number:clients[1100].phones[0].number,operation_id:randomUUID()});
 expect(r.phone_match).toBe("matched");expect(r.records[0].id).toBe("c1100");expect(run.mock.calls.some(([q])=>q.includes("VoiceClients("))).toBe(false);
 const before=run.mock.calls.length;
 const intake={name:"Another name",callback_number:clients[1100].phones[0].number,service:"Plumbing",description:"Leak",street1:"2 Main Street",city:"Englehart"};
 const pf=await s.dispatch({action:"preflight",call_id:"call",caller_number:clients[1100].phones[0].number,operation_id:randomUUID(),intake});
 expect(pf.preflight_state).toBe("selection_required");expect(pf.choices[0].id).toBe("c1100");
 expect(run.mock.calls.slice(before).every(([q])=>q.includes("VoiceAccount") || q.includes("VoiceClient("))).toBe(true);
 const ready=await s.dispatch({action:"preflight",call_id:"call",caller_number:clients[1100].phones[0].number,operation_id:randomUUID(),intake:{...intake,client_id:"c1100"}});
 expect(ready.preflight_state).toBe("ready");expect(run.mock.calls.filter(([q])=>q.includes("VoiceCensusClients"))).toHaveLength(56);
});

it("an indexed miss returns unresolved quickly and never claims a new customer",async()=>{
 const j=journal();j.publishDirectory("williams","gen");
 const run=vi.fn(async(q:string)=>{if(q.includes("VoiceAccount"))return {account:{id:"williams"}};throw Error("unexpected directory scan")});
 const r=await new VoiceService(j,run,"williams").dispatch({action:"resolve",call_id:"call",caller_number:"+17055550100",operation_id:randomUUID()});
 expect(r).toMatchObject({outcome:"completed",phone_match:"unresolved",discovery_complete:false,records:[]});expect(run).toHaveBeenCalledTimes(1);
});

it("an orphaned completed census cannot publish an empty generation after a crash",async()=>{
 const j=journal();j.addDirectoryPhone("williams","previous","+17055550100","c1");j.publishDirectory("williams","previous");
 j.setCheckpoint("directory:williams:census:previous",{version:1,complete:true,clients:1});
 // Also cover a checkpoint left by the first batched implementation or rollback.
 j.setCheckpoint("directory:williams:census",{version:1,complete:true,clients:1});
 const run=vi.fn(async(q:string)=>q.includes("VoiceAccount") ? {account:{id:"williams"}}:{clients:conn([{id:"c1",phones:[{number:"+17055550100"}],contacts:conn([])}])});
 const s=new VoiceService(j,run,"williams");await s.directory.refresh();
 expect(s.directory.candidates("+17055550100")).toEqual(["c1"]);expect(run.mock.calls.some(([q])=>q.includes("VoiceCensusClients"))).toBe(true);
});

it("replaying a visit after a crash does not duplicate directory progress",async()=>{
 const j=journal();const state={version:3,generation:"gen",clients:["c1"],clientOffset:1};j.setCheckpoint("directory:williams",state);
 j.addDirectoryPhone("williams","gen","+17055550100","c1");
 j.setCheckpoint("directory:williams:census:gen",{version:1,started_at:Date.now(),after:null,page:conn([{id:"c1",phones:[{number:"+17055550100"}],contacts:conn([])}]),offset:0,clients:0,complete:false});
 const run=vi.fn(async()=>({account:{id:"williams"}}));const s=new VoiceService(j,run,"williams");await s.directory.refresh();
 expect(s.directory.candidates("+17055550100")).toEqual(["c1"]);expect(j.directoryRecords("williams")).toHaveLength(1);expect(run).toHaveBeenCalledTimes(1);
});
