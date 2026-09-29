const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const INDEX_FILE = path.join(__dirname, "public", "index.html");
const MAX_PLAYERS = 60;
const QUESTION_SECONDS = 20;

// 15 questions: 10 core + 5 harder/coding-style questions.
const QUESTIONS = [
  { q: "Who developed Python?", a: ["Guido van Rossum", "Dennis Ritchie", "James Gosling", "Bjarne Stroustrup"], c: 0 },
  { q: "Which is a valid Python variable name?", a: ["2name", "user-name", "total_score", "class"], c: 2 },
  { q: "True or False: Python variable names are case-sensitive, so myVar and myvar are different names.", a: ["True", "False"], c: 0 },
  { q: "What is the output?\n\nx = 10\nx = \"Python\"\nprint(x)", a: ["10", "Python", "10 Python", "Error"], c: 1 },
  { q: "Which data type represents a decimal value such as 5.0?", a: ["int", "float", "bool", "str"], c: 1 },
  { q: "What is the output?\n\nprint(15 // 4)", a: ["3", "3.75", "4", "0"], c: 0 },
  { q: "Which collection is ordered and mutable?", a: ["Tuple", "Set", "List", "Boolean"], c: 2 },
  { q: "Which of the following are Python numeric data types? (Select all that apply)", a: ["int", "float", "complex", "string"], c: [0,1,2], multi: true },
  { q: "What is the output?\n\na = 10\nb = 4\nprint(a & b)", a: ["0", "14", "2", "40"], c: 0 },
  { q: "Which operator is used for exponentiation in Python?", a: ["//", "%", "**", "<<"], c: 2 },
  { q: "True or False: Python's input() function returns user input as a string by default.", a: ["True", "False"], c: 0 },
  { q: "What is the output?\n\nx, y, z = 1, 2.5, \"Python\"\nprint(y)", a: ["1", "2.5", "Python", "Error"], c: 1 },
  { q: "What is the output?\n\ns = [10, 20, 30]\ns.append(40)\nprint(s)", a: ["[10, 20, 30]", "[40, 10, 20, 30]", "[10, 20, 30, 40]", "40"], c: 2 },
  { q: "What is the output?\n\nstudent = {\"name\": \"Ravi\", \"age\": 20}\nprint(student[\"name\"])", a: ["student", "name", "Ravi", "20"], c: 2 },
  { q: "What is the output?\n\nx = True\ny = False\nprint(x and y)", a: ["True", "False", "1", "Error"], c: 1 }
];

const rooms = new Map();

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function broadcast(room, message) {
  if (room.host) send(room.host.ws, message);
  for (const p of room.players.values()) send(p.ws, message);
}
function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}
function playerList(room, includeScores) {
  return [...room.players.values()].map(p => includeScores
    ? {id:p.id,name:p.name,score:p.score}
    : {id:p.id,name:p.name});
}
function sendState(room) {
  send(room.host.ws, {type:"state", players:playerList(room,true), started:room.started, questionIndex:room.questionIndex, maxPlayers:MAX_PLAYERS, chatEnabled:room.chatEnabled});
  for (const p of room.players.values()) {
    send(p.ws, {type:"state", players:playerList(room,false), started:room.started, questionIndex:room.questionIndex, maxPlayers:MAX_PLAYERS, chatEnabled:room.chatEnabled});
  }
}
function sendQuestion(room) {
  clearTimeout(room.questionTimer);
  room.questionIndex++;
  room.answers.clear();
  if (room.questionIndex >= QUESTIONS.length) return finishQuiz(room);
  const q = QUESTIONS[room.questionIndex];
  broadcast(room,{type:"question",index:room.questionIndex,total:QUESTIONS.length,question:q.q,answers:q.a,seconds:QUESTION_SECONDS,multi:!!q.multi});
  room.questionTimer=setTimeout(()=>sendQuestion(room),QUESTION_SECONDS*1000);
}
function finishQuiz(room) {
  clearTimeout(room.questionTimer);
  room.started=false;
  const leaderboard=[...room.players.values()].map(p=>({name:p.name,score:p.score})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  // Host sees the complete leaderboard. Each student gets only their own result + full answer key.
  send(room.host.ws,{type:"finished",host:true,leaderboard,answerKey:QUESTIONS.map(q=>({q:q.q,answers:q.a,correct:q.c}))});
  for(const p of room.players.values()){
    send(p.ws,{type:"finished",host:false,score:p.score,total:QUESTIONS.length,answerKey:QUESTIONS.map((q,i)=>({q:q.q,answers:q.a,correct:q.c,selected:p.history[i] ?? null}))});
  }
}
function startQuiz(room){
  if(room.started)return;
  room.started=true;room.questionIndex=-1;room.answers.clear();
  for(const p of room.players.values()){p.score=0;p.history=[];}
  broadcast(room,{type:"countdown",seconds:3});
  setTimeout(()=>{if(rooms.get(room.code)===room&&room.started)sendQuestion(room);},3000);
}

const server=http.createServer((req,res)=>{
  if(req.method==="GET"&&(req.url==="/"||req.url==="/index.html")){
    try{const html=fs.readFileSync(INDEX_FILE);res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(html);}
    catch(e){res.writeHead(500);res.end("Quiz page could not be loaded.");}
    return;
  }
  res.writeHead(404);res.end("Not found");
});
const wss=new WebSocket.Server({server});

wss.on("connection",ws=>{
  ws.id=Math.random().toString(36).slice(2);ws.roomCode=null;ws.role=null;
  ws.on("message",raw=>{
    let m;try{m=JSON.parse(raw.toString())}catch{return send(ws,{type:"error",message:"Invalid message."})}
    if(m.type==="create"){
      const name=String(m.name||"").trim().slice(0,24);if(!name)return send(ws,{type:"error",message:"Enter a host name."});
      const code=makeRoomCode();const room={code,host:{id:ws.id,name,ws},players:new Map(),started:false,questionIndex:-1,questionTimer:null,answers:new Set(),chatEnabled:true,createdAt:Date.now()};
      rooms.set(code,room);ws.roomCode=code;ws.role="host";
      send(ws,{type:"created",code,maxPlayers:MAX_PLAYERS});sendState(room);return;
    }
    if(m.type==="join"){
      const code=String(m.code||"").trim().toUpperCase();const name=String(m.name||"").trim().slice(0,24);const room=rooms.get(code);
      if(!name)return send(ws,{type:"error",message:"Enter your name."});
      if(!room)return send(ws,{type:"error",message:"Room not found."});
      if(room.started)return send(ws,{type:"error",message:"This quiz has already started."});
      if(room.players.size>=MAX_PLAYERS)return send(ws,{type:"error",message:"Room is full (60 players max)."});
      room.players.set(ws.id,{id:ws.id,name,ws,score:0,history:[]});ws.roomCode=code;ws.role="player";
      send(ws,{type:"joined",code});sendState(room);return;
    }
    const room=rooms.get(ws.roomCode);if(!room)return send(ws,{type:"error",message:"You are not in a room."});
    if(m.type==="start"){
      if(ws.role!=="host")return send(ws,{type:"error",message:"Only the host can start the quiz."});
      if(room.players.size===0)return send(ws,{type:"error",message:"Wait for at least one player to join."});
      startQuiz(room);return;
    }
    if(m.type==="answer"){
      if(ws.role!=="player"||!room.started||room.questionIndex<0||room.questionIndex>=QUESTIONS.length||room.answers.has(ws.id))return;
      const p=room.players.get(ws.id),q=QUESTIONS[room.questionIndex];if(!p)return;
      let selected=m.answer;
      if(q.multi){
        if(!Array.isArray(selected)) selected=[];
        selected=selected.map(Number).filter(Number.isInteger).sort((a,b)=>a-b);
        p.history[room.questionIndex]=selected;
      } else {
        selected=Number(selected);
        p.history[room.questionIndex]=Number.isInteger(selected)?selected:null;
      }
      room.answers.add(ws.id);
      const correct=q.multi ? JSON.stringify(selected)===JSON.stringify([...q.c].sort((a,b)=>a-b)) : selected===q.c;
      if(correct)p.score++;
      send(ws,{type:"answerResult",correct,score:p.score});sendState(room);return;
    }
    if(m.type==="chat"){
      if(!room.chatEnabled)return;
      const text=String(m.text||"").trim().slice(0,180);if(!text)return;
      const name=ws.role==="host"?room.host.name:(room.players.get(ws.id)?.name||"Player");
      broadcast(room,{type:"chat",name,text,host:ws.role==="host",ts:Date.now()});return;
    }
    if(m.type==="chatToggle"){
      if(ws.role!=="host")return send(ws,{type:"error",message:"Only the host can control chat."});
      room.chatEnabled=!!m.enabled;broadcast(room,{type:"chatStatus",enabled:room.chatEnabled});sendState(room);return;
    }
  });
  ws.on("close",()=>{
    const code=ws.roomCode;if(!code)return;const room=rooms.get(code);if(!room)return;
    if(ws.role==="host"){
      clearTimeout(room.questionTimer);broadcast(room,{type:"error",message:"The host left. This room is closed."});rooms.delete(code);return;
    }
    room.players.delete(ws.id);sendState(room);
  });
});
server.listen(PORT,HOST,()=>console.log(`Python Cinematic Quiz Arena running on port ${PORT}`));
