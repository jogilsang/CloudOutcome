// Evidence exports: JSON (machine readable), a self-contained HTML report, or the browser print
// dialog (choose a printer or "Save as PDF"). Values are escaped; nothing is fetched remotely.

export type ReportRow={kpi:string;value:string;target:string;status:string};
export type ReportSection={title:string;subtitle?:string;rows:ReportRow[]};
export type Report={title:string;generatedAt:string;notes:string[];sections:ReportSection[];data:unknown};

const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

export function reportHtml(r:Report){
 const table=(s:ReportSection)=>`<section><h2>${esc(s.title)}</h2>${s.subtitle?`<p class="sub">${esc(s.subtitle)}</p>`:''}<table><thead><tr><th>KPI</th><th>Value</th><th>Target</th><th>Status</th></tr></thead><tbody>${
  s.rows.map(x=>`<tr><td>${esc(x.kpi)}</td><td><b>${esc(x.value)}</b></td><td>${esc(x.target)}</td><td class="${x.status==='ok'?'ok':x.status==='breach'?'bad':'na'}">${esc(x.status)}</td></tr>`).join('')}</tbody></table></section>`;
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title)}</title>
<style>body{font-family:-apple-system,"Segoe UI","Apple SD Gothic Neo",sans-serif;color:#382819;background:#fff9e9;margin:0;padding:32px;max-width:960px;margin:auto}
h1{margin:0 0 4px}h2{font-size:17px;margin:0 0 4px}.meta,.sub,li{color:#7a6a4f;font-size:13px}section{background:#fff;border:1px solid #e9dfc5;border-radius:10px;padding:18px;margin:16px 0}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}th,td{text-align:left;padding:8px;border-bottom:1px solid #eee3c9}th{color:#8a7a5a;font-weight:600}
.ok{color:#2a816d;font-weight:700}.bad{color:#9b6c1f;font-weight:700}.na{color:#999}@media print{body{background:#fff;padding:0}section{break-inside:avoid}}</style></head>
<body><h1>${esc(r.title)}</h1><p class="meta">Generated ${esc(r.generatedAt)} · CloudOutcome</p>${r.sections.map(table).join('')}
<section><h2>Notes</h2><ul>${r.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></section></body></html>`;
}

function download(name:string,type:string,body:string){
 const url=URL.createObjectURL(new Blob([body],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export const exportJson=(r:Report)=>download('cloudoutcome-evidence.json','application/json',JSON.stringify({title:r.title,generated_at:r.generatedAt,sections:r.sections,notes:r.notes,data:r.data},null,2));
export const exportHtml=(r:Report)=>download('cloudoutcome-report.html','text/html',reportHtml(r));
// Opens the report in a new window and prints it, so the app chrome is never printed.
export function exportPrint(r:Report){
 const w=window.open('','_blank');
 if(!w){download('cloudoutcome-report.html','text/html',reportHtml(r));return false}
 w.document.write(reportHtml(r));w.document.close();w.focus();setTimeout(()=>w.print(),300);return true;
}
