import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {VoiceCensus} from "../census.js";
import {VoiceJournal} from "../journal.js";
import {readFailureReason} from "../read-failure.js";
import {BudgetUnavailableError,RequestRateLimitError} from "../../jobber/cost-governor.js";
import {JobberApiError,JobberGraphQLRequestError} from "../../jobber/errors.js";

const dirs:string[]=[],journals:VoiceJournal[]=[];
const conn=(nodes:any[],hasNextPage=false,endCursor:string|null=null)=>({nodes,pageInfo:{hasNextPage,endCursor}});
const contact=(id:string)=>({id,name:id,phones:conn([]),emails:conn([]),properties:conn([])});
function journal(){const dir=mkdtempSync(path.join(os.tmpdir(),"voice-census-"));dirs.push(dir);const j=new VoiceJournal(path.join(dir,"journal.db"));journals.push(j);return j;}
afterEach(()=>{journals.splice(0).forEach(j=>j.close());dirs.splice(0).forEach(d=>rmSync(d,{force:true,recursive:true}));});

it("paginates client contacts and every nested contact field without losing overflow",async()=>{
 const j=journal();const first={...contact("one"),phones:conn([{number:"1"}],true,"phone-page"),emails:conn([{address:"first"}],true,"email-page"),properties:conn([{id:"p1"}],true,"property-page")};
 const run=vi.fn(async(q:string,v:any={})=>{
  if(q.includes("VoiceCensusClients"))return {clients:conn([{id:"client",contacts:conn([first],true,"contact-page")}])};
  if(q.includes("VoiceCensusContacts")){expect(q).toContain("includePropertyContacts:true");expect(v.after).toBe("contact-page");return {client:{contacts:conn([contact("two")])}};}
  if(q.includes("VoiceCensusPhones"))return {clientContact:{phones:conn([{number:"2"}])}};
  if(q.includes("VoiceCensusEmails"))return {clientContact:{emails:conn([{address:"second"}])}};
  if(q.includes("VoiceCensusProperties"))return {clientContact:{properties:conn([{id:"p2"}])}};
  throw Error("unexpected");
 });
 const seen:any[]=[];await new VoiceCensus(j,run).scan("scan",c=>{seen.push(c)});
 expect(seen[0].contacts).toHaveLength(2);expect(seen[0].contacts[0]).toMatchObject({phones:[{number:"1"},{number:"2"}],emails:[{address:"first"},{address:"second"}],properties:[{id:"p1"},{id:"p2"}]});
 expect(run.mock.calls).toHaveLength(5);
});

it("retains completed clients across restart and never publishes incomplete overflow",async()=>{
 const j=journal();let fail=true;const seen:string[]=[];
 const run=vi.fn(async(q:string)=>{
  if(q.includes("VoiceCensusClients"))return {clients:conn([{id:"complete",contacts:conn([])},{id:"incomplete",contacts:conn([{...contact("ct"),phones:conn([],true,"more")}])}])};
  if(fail)throw new BudgetUnavailableError(6);
  return {clientContact:{phones:conn([{number:"7055550100"}])}};
 });
 await expect(new VoiceCensus(j,run).scan("scan",c=>{seen.push(c.id)})).rejects.toThrow("budget");expect(seen).toEqual(["complete"]);
 fail=false;await new VoiceCensus(j,run).scan("scan",c=>{seen.push(c.id)});
 expect(seen).toEqual(["complete","incomplete"]);expect(run.mock.calls.filter(([q])=>q.includes("VoiceCensusClients"))).toHaveLength(1);
});

it("rejects incomplete contact pages and classifies errors without private messages",async()=>{
 const j=journal();const run=async()=>({clients:conn([{id:"c",contacts:{nodes:[]}}])});
 await expect(new VoiceCensus(j,run).scan("bad",()=>{})).rejects.toThrow("Incomplete");
 expect(readFailureReason(new BudgetUnavailableError(6))).toBe("budget_refilling");
 expect(readFailureReason(new RequestRateLimitError(20))).toBe("request_rate_limited");
 expect(readFailureReason(new JobberApiError("Jobber API is still throttled after one retry"))).toBe("provider_throttled");
 expect(readFailureReason(new JobberGraphQLRequestError("private customer details"))).toBe("provider_rejected_read");
});
