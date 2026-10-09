/** Small reviewed equivalences, never guesses about civic numbers or units. */
export function normalizedText(value:unknown):string {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[.,]/g," ").replace(/\s+/g," ").trim();
}
export function normalizedStreet(value:unknown):string {
  const suffixes:Record<string,string>={st:"street",rd:"road",ave:"avenue",av:"avenue",blvd:"boulevard",dr:"drive",ln:"lane",crt:"court",ct:"court",hwy:"highway",pl:"place",cres:"crescent"};
  const words=normalizedText(value).split(" ");
  // Only a trailing suffix (possibly followed by a direction) is expanded.
  const n=words.length-1, at=/^(north|south|east|west|n|s|e|w)$/.test(words[n]) ? n-1:n;
  if(suffixes[words[at]])words[at]=suffixes[words[at]];
  return words.join(" ");
}
export function addressMatches(p:any,i:any):boolean {
  return !!i.street1 && !!i.city && normalizedStreet(p.street1)===normalizedStreet(i.street1)
    && normalizedText(p.street2)===normalizedText(i.street2) && normalizedText(p.city)===normalizedText(i.city)
    && (!i.province || !p.province || normalizedText(p.province)===normalizedText(i.province))
    && (!i.postal_code || !p.postalCode || String(p.postalCode).replace(/\s/g,"").toLowerCase()===String(i.postal_code).replace(/\s/g,"").toLowerCase());
}
export class WorkflowRequired extends Error {
  constructor(readonly code:string,readonly nextAction:string,readonly choices:any[]=[]) {super(code);}
}
export class KeyedGate {
  private tails=new Map<string,Promise<void>>();
  async run<T>(key:string,work:()=>Promise<T>):Promise<T> {
    const previous=this.tails.get(key) || Promise.resolve();
    let release!:()=>void;
    const next=new Promise<void>(r=>{release=r;});this.tails.set(key,next);
    await previous;
    try{return await work();}finally{release();if(this.tails.get(key)===next)this.tails.delete(key);}
  }
}
