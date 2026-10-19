// Customer-facing projections: never forward provider records to the voice model.
export function customerStatus(value: unknown): string {
  const key = String(value || "").toLowerCase();
  return ({ active: "active", upcoming: "scheduled", today: "scheduled", unscheduled: "unscheduled", new: "received", completed: "completed", assessment_completed: "assessment completed", converted: "converted to work", archived: "archived", on_hold: "on hold" } as Record<string,string>)[key] || "status unavailable";
}
export function serviceAddress(p: any): Record<string,unknown> | null {
  if (!p) return null;
  return { id:p.id, street:p.street1 || "", unit:p.street2 || "", city:p.city || "", province:p.province || "", postal_code:p.postalCode || "", address:[p.street1,p.street2,p.city,p.province,p.postalCode].filter(Boolean).join(", ") };
}
export function contactDetails(c: any, clientLevel=false): Record<string,unknown> {
  const values=(v:any)=>Array.isArray(v) ? v:v?.nodes || [];
  const relevant=(v:any)=>!clientLevel || !v.contact?.id;
  return { id:c.id, name:c.name || "", company:clientLevel ? c.companyName || "":"",
    phones:values(c.phones).filter(relevant).map((p:any)=>({number:p.number,primary:p.primary===true})),
    emails:values(c.emails).filter(relevant).map((e:any)=>({address:e.address,primary:e.primary===true})) };
}
export function appointment(a:any, arrivalWindow?:any): Record<string,unknown> {
  const present=(v:any)=>typeof v==="string" && Number.isFinite(Date.parse(v));
  const dates=present(a.startAt) && present(a.endAt) && Date.parse(a.endAt)>=Date.parse(a.startAt);
  const mode=a.startAt===null && a.endAt===null ? "unscheduled":present(a.startAt) && a.allDay===true ? "date_only":dates ? "timed":"unknown";
  const completed=a.isComplete===true;
  const window=arrivalWindow || a.arrivalWindow;
  return { id:a.id, mode, completed, start_at:mode==="timed" || mode==="date_only" ? a.startAt:null,
    // A planned end is never an arrival window.
    end_at:mode==="timed" ? a.endAt:null,
    arrival_window:mode==="timed" && present(window?.startAt) && present(window?.endAt) && Date.parse(window.endAt)>=Date.parse(window.startAt) ? {start_at:window.startAt,end_at:window.endAt}:null,
    timing:completed ? "completed":mode==="unscheduled" ? "unscheduled":mode==="unknown" ? "unknown":Date.parse(a.startAt)<Date.now() ? "recorded_past":"upcoming" };
}
