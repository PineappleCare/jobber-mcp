// Disposable loopback integration fixture. No OAuth, customer data or live Jobber access.
import path from "node:path";
import { randomBytes } from "node:crypto";
// Audit and OAuth lookups must never touch a developer's home state or Keychain.
process.env.JOBBER_STATE_DIR = path.dirname(process.argv[2]);
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { VoiceJournal } from "../build/voice/journal.js";
import { VoiceService } from "../build/voice/service.js";
import { registerVoiceRoutes } from "../build/voice/http.js";
const pi = { hasNextPage: false, endCursor: null }, conn = nodes => ({ nodes, pageInfo: pi });
const cs=[], requests=[], messages=[];
let assessment=null;
const run=async (q,v={})=>{
 if(q.includes("VoiceAccount"))return{account:{id:"fixture-williams"}};
 if(q.includes("VoiceCensusClients("))return{clients:conn(cs.map(c=>({...c,contacts:conn([])})))};
 if(q.includes("VoiceClients("))return{clients:conn(cs)};
 if(q.includes("VoiceClient("))return{client:cs.find(c=>c.id===v.id)};
 if(q.includes("VoiceContacts")||q.includes("VoiceContactEmails"))return{client:{contacts:conn([])}};
 if(q.includes("VoiceClientRequests"))return{client:{requests:conn(requests)}};
 if(q.includes("VoiceClientJobs"))return{client:{jobs:conn([{id:"fixture-job",title:"Tap repair",jobStatus:"ACTIVE",client:{id:"fixture-client"},property:{id:"fixture-property"},jobberWebUri:"https://secure.getjobber.com/jobs/fixture-job"}])}};
 if(q.includes("VoiceCreateClient")){const c={...v.input,id:"fixture-client",lastName:v.input.lastName||"",companyName:v.input.companyName||"",properties:[],jobberWebUri:"https://secure.getjobber.com/clients/fixture-client"};cs.push(c);return{clientCreate:{client:c,userErrors:[]}};}
 if(q.includes("VoiceCreateProperty")){const p={...v.input.properties[0].address,id:"fixture-property"};cs[0].properties.push(p);return{propertyCreate:{properties:[p],userErrors:[]}};}
 if(q.includes("VoiceCreateRequest")){const r={id:"fixture-request",title:v.input.title,requestStatus:"NEW",client:{id:v.input.clientId},property:{id:v.input.propertyId},jobberWebUri:"https://secure.getjobber.com/requests/fixture-request"};requests.push(r);return{requestCreate:{request:r,userErrors:[]}};}
 if(q.includes("VoiceRequest("))return{request:{...requests[0],assessment}};
 if(q.includes("VoiceCreateAssessment")){assessment={id:"fixture-assessment",instructions:v.input.instructions,startAt:null,endAt:null,assignedUsers:conn([])};return{assessmentCreate:{assessment,userErrors:[]}};}
 if(q.includes("mutation VoiceRequestNote(")){const n={id:"fixture-note-"+messages.length,message:v.input.message};messages.push(n);return{requestCreateNote:{requestNote:n,userErrors:[]}};}
 if(q.includes("VoiceRequestNotes"))return{request:{notes:conn(messages)}};
 throw Error("Unsupported fixture operation");
};
const app=new Hono();registerVoiceRoutes(app,new VoiceService(new VoiceJournal(process.argv[2]),run,"fixture-williams"),"x".repeat(40));
const server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0},info=>console.log(`http://127.0.0.1:${info.port}`));
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
