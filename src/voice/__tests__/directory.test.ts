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
   if(q.includes("VoiceIndexClients"))return {clients:conn([{id:"c1",phones:[{number:"7055550100"},{number:"7055550102"}]}])};
   expect(q).toContain("includePropertyContacts:true");
   if(v.after==="ct1"){if(fail)throw Error("connection lost");return {client:{contacts:conn([{id:"ct2",phones:conn([{number:"7055550104"}])}])}};}
   return {client:{contacts:conn([{id:"ct1",phones:conn([{number:"7055550103"}])}],true,"ct1")}};
  });
  const first=new VoiceService(j,run,"williams");
  await expect(first.directory.refresh()).rejects.toThrow("connection lost");expect(first.directory.candidates("+17055550103")).toBeUndefined();expect(first.directory.status().last_failure_at).not.toBeNull();
  fail=false;const restarted=new VoiceService(j,run,"williams");await restarted.directory.refresh();
  expect(run.mock.calls.filter(([q])=>q.includes("VoiceIndexClients")).length).toBe(1);
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
  expect(result.phone_match).toBe("unmatched");expect(result.records).toEqual([]);
 });
 it("returns pending within the voice deadline while a read continues",async()=>{
  vi.useFakeTimers();const j=journal();j.publishDirectory("williams","empty");let release!:(x:any)=>void;
  const run=vi.fn(async(q:string)=>{if(q.includes("VoiceAccount"))return {account:{id:"williams"}};return await new Promise(r=>{release=r});});
  const s=new VoiceService(j,run,"williams");const args={action:"resolve",call_id:"call",caller_number:"+17055550100",operation_id:randomUUID()};
  const pending=s.dispatch(args);await vi.advanceTimersByTimeAsync(2000);expect((await pending).outcome).toBe("pending");
  release({clients:conn([])});await vi.advanceTimersByTimeAsync(1);
  expect(j.get(args.operation_id,args.call_id).outcome).toBe("completed");
 });
 it("persists completed scan pages so a temporary failure does not restart the full scan",async()=>{
  const j=journal();let fail=true;
  const run=vi.fn(async(q:string,v:any={})=>{
   if(q.includes("VoiceAccount"))return {account:{id:"williams"}};
   if(q.includes("VoiceClients")){if(v.after==="next" && fail)throw Error("THROTTLED");return {clients:conn([],!v.after,v.after?null:"next")};}
   throw Error("unexpected");
  });
  j.publishDirectory("williams","empty");const args={action:"resolve",call_id:"call",caller_number:"+17055550100",operation_id:randomUUID()};
  const s=new VoiceService(j,run,"williams");expect((await s.dispatch(args)).outcome).toBe("pending");fail=false;
  const restarted=new VoiceService(j,run,"williams");expect((await restarted.dispatch(args)).outcome).toBe("completed");
  expect(run.mock.calls.filter(([q,v])=>q.includes("VoiceClients")&&!v.after).length).toBe(1);
 });
});

it("fully indexes more than a thousand clients without doing a full scan for a matched caller",async()=>{
 const j=journal();const clients=Array.from({length:1101},(_,i)=>({id:`c${i}`,phones:[{number:`+1705${String(i).padStart(7,"0")}`}]}));
 const run=vi.fn(async(q:string,v:any={})=>{
  if(q.includes("VoiceAccount"))return {account:{id:"williams"}};
  if(q.includes("VoiceIndexClients")){const start=Number(v.after||0),end=Math.min(start+50,clients.length);return {clients:conn(clients.slice(start,end),end<clients.length,end<clients.length?String(end):null)};}
  if(q.includes("VoiceIndexContacts")||q.includes("VoiceContacts"))return {client:{contacts:conn([])}};
  if(q.includes("VoiceClient("))return {client:{...clients[1100],name:"Authorized",properties:[]}};
  if(q.includes("VoiceClientRequests"))return {client:{requests:conn([])}};
  if(q.includes("VoiceClientJobs"))return {client:{jobs:conn([])}};
  throw Error("unexpected full scan");
 });
 const s=new VoiceService(j,run,"williams");await s.directory.refresh();expect(run.mock.calls.filter(([q])=>q.includes("VoiceIndexClients")).length).toBe(23);
 const r=await s.dispatch({action:"resolve",call_id:"call",caller_number:clients[1100].phones[0].number,operation_id:randomUUID()});
 expect(r.phone_match).toBe("matched");expect(r.records[0].id).toBe("c1100");expect(run.mock.calls.some(([q])=>q.includes("VoiceClients("))).toBe(false);
});
