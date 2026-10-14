const $ = (id) => document.getElementById(id);
const STAGES = ["IF","ID","EX","MEM","WB"];
const REG_COUNT = 32;
let state = null;
let timer = null;

function freshState(){
  const regs = Array(REG_COUNT).fill(0);
  regs[6]=4; regs[7]=8; regs[10]=100; regs[12]=3; regs[13]=200;
  return {regs,memory:new Map([[0,111],[4,222],[8,333],[100,7],[104,9],[200,0],[208,0]]),program:[],pcToIndex:new Map(),fetchPc:Number($("startPcInput")?.value||40),cycle:0,pipeline:{IF:null,ID:null,EX:null,MEM:null,WB:null},history:[],logs:[],retired:0,stalls:0,flushes:0,forwardings:0,exceptions:0,predictor:new Map(),halted:false};
}
function parseReg(s){const m=/^x([0-9]|[12][0-9]|3[01])$/i.exec(s.trim());if(!m)throw new Error(`Registro inválido: ${s}`);return Number(m[1]);}
function parseImm(s){s=s.trim();if(/^[-+]?0x/i.test(s))return parseInt(s,16);const n=Number(s);if(!Number.isFinite(n))throw new Error(`Inmediato inválido: ${s}`);return n;}
function parseLine(raw,idx,pc){
  const clean=raw.split("#")[0].trim(); if(!clean)return null;
  const parts=clean.replace(/,/g," ").split(/\s+/), op=parts[0].toLowerCase();
  const ins={id:idx+1,pc,text:clean,op,rd:null,rs1:null,rs2:null,imm:0,type:"",meta:{}};
  if(["add","sub","and","or"].includes(op)){if(parts.length!==4)throw new Error(`Sintaxis: ${op} rd, rs1, rs2`);ins.rd=parseReg(parts[1]);ins.rs1=parseReg(parts[2]);ins.rs2=parseReg(parts[3]);ins.type="R";}
  else if(op==="addi"){if(parts.length!==4)throw new Error("Sintaxis: addi rd, rs1, imm");ins.rd=parseReg(parts[1]);ins.rs1=parseReg(parts[2]);ins.imm=parseImm(parts[3]);ins.type="I";}
  else if(["lw","sw"].includes(op)){if(parts.length!==3)throw new Error(`Sintaxis: ${op} r, imm(rs1)`);const mm=/^(.+)\((x(?:[0-9]|[12][0-9]|3[01]))\)$/i.exec(parts[2]);if(!mm)throw new Error(`Dirección inválida en: ${clean}`);if(op==="lw")ins.rd=parseReg(parts[1]);else ins.rs2=parseReg(parts[1]);ins.rs1=parseReg(mm[2]);ins.imm=parseImm(mm[1]);ins.type=op==="lw"?"LOAD":"STORE";}
  else if(["beq","bne"].includes(op)){if(parts.length!==4)throw new Error(`Sintaxis: ${op} rs1, rs2, offset`);ins.rs1=parseReg(parts[1]);ins.rs2=parseReg(parts[2]);ins.imm=parseImm(parts[3]);ins.type="BRANCH";}
  else if(op==="nop") ins.type="NOP"; else ins.type="ILLEGAL";
  return ins;
}
function assemble(){
  stopRun(); state=freshState(); const lines=$("programInput").value.split(/\n/); let pc=Number($("startPcInput").value||40),idx=0;
  try{for(const raw of lines){const ins=parseLine(raw,idx,pc);if(ins){state.program.push(ins);state.pcToIndex.set(pc,state.program.length-1);idx++;pc+=4;}}if(!state.program.length)throw new Error("No hay instrucciones.");state.fetchPc=Number($("startPcInput").value||40);state.history=state.program.map(i=>({ins:i,cells:{},flushed:false}));state.logs.push({cycle:0,type:"neutral",msg:`Programa preparado: ${state.program.length} instrucciones.`});setStatus("Preparado");setEvent("neutral","Programa preparado","Usa Siguiente ciclo o Ejecutar.");render();}
  catch(e){setEvent("exception","Error de ensamblado",e.message);setStatus("Error");}
}
function cloneIns(ins){return ins?{...ins,meta:{...(ins.meta||{})}}:null;}
function getReg(r){return r===0?0:state.regs[r];}
function writeReg(r,v){if(r!==null&&r!==0)state.regs[r]=v|0;}
function destReg(ins){return ins&&["R","I","LOAD"].includes(ins.type)?ins.rd:null;}
function readsReg(ins,r){return !!(ins&&r!==null&&r!==0&&(ins.rs1===r||ins.rs2===r));}
function resolveOperand(reg){
  if(reg===null)return{value:0,from:"none"}; if(reg===0)return{value:0,from:"x0"};
  const mem=state.pipeline.MEM,wb=state.pipeline.WB,md=destReg(mem),wd=destReg(wb);
  if(mem&&md===reg&&mem.type!=="LOAD"&&mem.meta?.result!==undefined){state.forwardings++;return{value:mem.meta.result,from:"EX/MEM"};}
  if(wb&&wd===reg&&wb.meta?.writeValue!==undefined){state.forwardings++;return{value:wb.meta.writeValue,from:"MEM/WB"};}
  return{value:getReg(reg),from:"REG"};
}
function predictTaken(ins){if(ins.type!=="BRANCH")return false;return $("predictorSelect").value==="1bit"?(state.predictor.get(ins.pc)===true):false;}
function updatePredictor(ins,taken){if($("predictorSelect").value==="1bit")state.predictor.set(ins.pc,taken);}
function instructionAtPc(pc){const ix=state.pcToIndex.get(pc);return ix===undefined?null:cloneIns(state.program[ix]);}
function pipelineEmpty(){return STAGES.every(s=>!state.pipeline[s]);}

function stepCycle(){
  if(!state||state.halted)return; state.cycle++;
  let event={type:"neutral",title:"Ciclo normal",text:"Las instrucciones avanzan por el pipeline."};
  let hazardNote="—",forwardNote="—",exceptionNote="—";
  const prev={...state.pipeline};

  const wb=prev.WB;
  if(wb){if(["R","I","LOAD"].includes(wb.type)&&wb.meta?.writeValue!==undefined)writeReg(wb.rd,wb.meta.writeValue);state.retired++;}

  const mem=prev.MEM; let memOut=mem?cloneIns(mem):null;
  if(memOut){
    if(memOut.type==="LOAD"){
      const addr=memOut.meta.addr;
      if($("exceptionsToggle").checked&&addr%4!==0){exceptionNote=`Acceso desalineado en ${addr}`;event={type:"exception",title:"Excepción en MEM",text:`${memOut.text}: dirección ${addr} no alineada a 4 bytes. Se descartan instrucciones jóvenes.`};state.exceptions++;memOut.meta.trap=true;}
      else memOut.meta.writeValue=state.memory.get(addr)??0;
    } else if(memOut.type==="STORE"){
      const addr=memOut.meta.addr;
      if($("exceptionsToggle").checked&&addr%4!==0){exceptionNote=`Acceso desalineado en ${addr}`;event={type:"exception",title:"Excepción en MEM",text:`${memOut.text}: dirección ${addr} no alineada. No se escribe memoria.`};state.exceptions++;memOut.meta.trap=true;}
      else state.memory.set(addr,memOut.meta.storeValue|0);
    } else if(["R","I"].includes(memOut.type)) memOut.meta.writeValue=memOut.meta.result;
  }

  const structural=$("unifiedMemoryToggle").checked&&mem&&["LOAD","STORE"].includes(mem.type);
  const id=prev.ID, ex=prev.EX;
  const loadUse=!!(id&&ex&&ex.type==="LOAD"&&readsReg(id,ex.rd));

  let exOut=ex?cloneIns(ex):null, branchFlush=false, branchTarget=null;
  if(exOut){
    if(exOut.type==="ILLEGAL"&&$("exceptionsToggle").checked){event={type:"exception",title:"Instrucción ilegal",text:`${exOut.text}: operación no soportada. Se descartan instrucciones posteriores.`};exceptionNote="Illegal instruction";state.exceptions++;branchFlush=true;exOut.meta.trap=true;}
    else if(["R","I","LOAD","STORE","BRANCH"].includes(exOut.type)){
      const a=resolveOperand(exOut.rs1), b=resolveOperand(exOut.rs2); const used=[a,b].filter(x=>["EX/MEM","MEM/WB"].includes(x.from));
      if(used.length){forwardNote=used.map(x=>x.from).join(" + ");event={type:"forward",title:"Forwarding aplicado",text:`${exOut.text}: operando reenviado desde ${forwardNote} hacia EX.`};}
      if(exOut.type==="R"){if(exOut.op==="add")exOut.meta.result=(a.value+b.value)|0;if(exOut.op==="sub")exOut.meta.result=(a.value-b.value)|0;if(exOut.op==="and")exOut.meta.result=(a.value&b.value)|0;if(exOut.op==="or")exOut.meta.result=(a.value|b.value)|0;}
      else if(exOut.type==="I") exOut.meta.result=(a.value+exOut.imm)|0;
      else if(exOut.type==="LOAD") exOut.meta.addr=(a.value+exOut.imm)|0;
      else if(exOut.type==="STORE"){exOut.meta.addr=(a.value+exOut.imm)|0;exOut.meta.storeValue=b.value;}
      else if(exOut.type==="BRANCH"){
        const taken=exOut.op==="beq"?a.value===b.value:a.value!==b.value; const predicted=!!exOut.meta.predictedTaken; updatePredictor(exOut,taken); exOut.meta.taken=taken;
        if(taken!==predicted){branchFlush=true;state.flushes++;branchTarget=taken?exOut.pc+exOut.imm:exOut.pc+4;state.fetchPc=branchTarget;event={type:"flush",title:"Misprediction → FLUSH",text:`${exOut.text}: predicho ${predicted?"Taken":"Not Taken"}, real ${taken?"Taken":"Not Taken"}. PC ← ${branchTarget}.`};}
      }
    }
  }

  let next={IF:null,ID:null,EX:exOut?null:null,MEM:exOut,WB:memOut};
  if(loadUse){
    next.EX=null;next.ID=prev.ID?cloneIns(prev.ID):null;next.IF=prev.IF?cloneIns(prev.IF):null;state.stalls++;hazardNote=`Load-use con x${ex.rd}`;event={type:"stall",title:"STALL por load-use",text:`${id.text} necesita x${ex.rd}, pero ${ex.text} aún obtiene el dato en MEM. Se inserta una burbuja.`};
  } else if(branchFlush){next.EX=null;next.ID=null;next.IF=null;}
  else{
    next.EX=prev.ID?cloneIns(prev.ID):null; next.ID=prev.IF?cloneIns(prev.IF):null;
    if(structural){next.IF=null;state.stalls++;hazardNote="Riesgo estructural: IF y MEM compiten por memoria";event={type:"stall",title:"STALL estructural",text:"MEM usa la memoria única para datos; IF no puede buscar una instrucción en el mismo ciclo."};}
    else{
      const fetched=instructionAtPc(state.fetchPc);
      if(fetched){if(fetched.type==="BRANCH"){fetched.meta.predictedTaken=predictTaken(fetched);state.fetchPc=fetched.meta.predictedTaken?fetched.pc+fetched.imm:state.fetchPc+4;}else state.fetchPc+=4;next.IF=fetched;}
    }
  }
  state.pipeline=next;

  for(const row of state.history){let cell="";for(const st of STAGES)if(state.pipeline[st]?.id===row.ins.id)cell=st;row.cells[state.cycle]=cell;}
  if(loadUse&&state.pipeline.ID)state.history[state.pipeline.ID.id-1].cells[state.cycle]="STALL";
  if(branchFlush){for(const old of [prev.IF,prev.ID])if(old&&state.history[old.id-1]){state.history[old.id-1].cells[state.cycle]="FLUSH";state.history[old.id-1].flushed=true;}}

  if(event.type!=="neutral"||state.cycle===1){state.logs.unshift({cycle:state.cycle,type:event.type,msg:`${event.title}: ${event.text}`});state.logs=state.logs.slice(0,30);}
  setEvent(event.type,event.title,event.text); $("hazardNote").textContent=hazardNote; $("forwardNote").textContent=forwardNote; $("exceptionNote").textContent=exceptionNote;

  const noMore=instructionAtPc(state.fetchPc)===null;
  if(noMore&&pipelineEmpty()){state.halted=true;stopRun();setStatus("Finalizado");}else setStatus("Ejecutando");
  render();
}

function setEvent(type,title,text){const box=$("eventBox");box.className=`event-box ${type||"neutral"}`;box.innerHTML=`<div class="event-icon">${type==="exception"?"⚠":type==="stall"?"⏸":type==="flush"?"↯":type==="forward"?"↗":"●"}</div><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;}
function setStatus(t){$("statusPill").textContent=t;}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));}
function renderRegisters(){const g=$("registerGrid");g.innerHTML="";state.regs.forEach((v,i)=>{const d=document.createElement("div");d.className="reg";d.innerHTML=`<b>x${i}</b><span>${i===0?0:v}</span>`;if(i!==0)d.onclick=()=>{const nv=prompt(`Nuevo valor para x${i}:`,String(state.regs[i]));if(nv!==null&&Number.isFinite(Number(nv))){state.regs[i]=Number(nv)|0;render();}};g.appendChild(d);});}
function renderPipeline(){const head=$("pipelineHead");head.innerHTML="<th>Instr.</th><th>PC</th><th>Código</th>";const maxC=Math.max(8,state.cycle);for(let c=1;c<=maxC;c++)head.innerHTML+=`<th>CC${c}</th>`;const body=$("pipelineBody");body.innerHTML="";for(const row of state.history){const tr=document.createElement("tr");tr.innerHTML=`<td>I${row.ins.id}</td><td>${row.ins.pc}</td><td class="code-cell">${escapeHtml(row.ins.text)}</td>`;for(let c=1;c<=maxC;c++){const val=row.cells[c]||"",cls=val?`stage-${val.toLowerCase()}`:"";tr.innerHTML+=`<td class="${cls}">${val}</td>`;}body.appendChild(tr);}}
function renderMemory(){const arr=[...state.memory.entries()].sort((a,b)=>a[0]-b[0]).slice(0,20);$("memoryView").textContent=arr.length?arr.map(([a,v])=>`M[${a}] = ${v}`).join("\n"):"Memoria vacía";if($("predictorSelect").value==="1bit"){const p=[...state.predictor.entries()].sort((a,b)=>a[0]-b[0]);$("predictorView").textContent=p.length?p.map(([pc,t])=>`PC ${pc}: ${t?"Taken":"Not Taken"}`).join("\n"):"Sin historial";}else $("predictorView").textContent="Modo: siempre Not Taken";}
function renderLogs(){$("eventLog").innerHTML=state.logs.map(l=>`<div class="log-row">CC${l.cycle} · ${escapeHtml(l.msg)}</div>`).join("");}
function renderDatapath(){document.querySelectorAll(".stage").forEach(n=>n.classList.remove("active"));for(const st of STAGES)if(state.pipeline[st])document.querySelector(`.stage[data-stage="${st}"]`)?.classList.add("active");}
function render(){if(!state)state=freshState();renderRegisters();renderPipeline();renderMemory();renderLogs();renderDatapath();$("cycleLabel").textContent=`Ciclo ${state.cycle}`;$("pcValue").textContent=state.fetchPc;$("retiredValue").textContent=state.retired;$("stallValue").textContent=state.stalls;$("flushValue").textContent=state.flushes;$("forwardValue").textContent=state.forwardings;$("exceptionValue").textContent=state.exceptions;}
function startRun(){if(!state)assemble();if(timer||state.halted)return;timer=setInterval(stepCycle,700);}
function stopRun(){if(timer){clearInterval(timer);timer=null;}}
function reset(){stopRun();state=freshState();setStatus("Listo");setEvent("neutral","Sin eventos","Prepara el programa y avanza ciclo por ciclo.");$("hazardNote").textContent="—";$("forwardNote").textContent="—";$("exceptionNote").textContent="—";render();}
function loadExample(){$("programInput").value=`add x5, x6, x7\nsub x8, x5, x10\nlw x9, 0(x10)\nadd x11, x9, x12\nbeq x11, x0, 8\nsw x8, 8(x13)\naddi x15, x0, 99`;$("startPcInput").value=40;}
$("assembleBtn").onclick=assemble;$("stepBtn").onclick=()=>{if(!state||!state.program.length)assemble();if(!state.halted)stepCycle();};$("runBtn").onclick=()=>{if(!state||!state.program.length)assemble();startRun();};$("pauseBtn").onclick=stopRun;$("resetBtn").onclick=reset;$("loadExampleBtn").onclick=loadExample;$("predictorSelect").onchange=render;reset();
