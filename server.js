const express=require('express');const path=require('path');const fs=require('fs');const Database=require('better-sqlite3');const bcrypt=require('bcryptjs');const jwt=require('jsonwebtoken');const multer=require('multer');const XLSX=require('xlsx');
const app=express();const db=new Database(path.join(__dirname,'packing.db'));const JWT_SECRET=process.env.JWT_SECRET||'TROQUE-ESTA-CHAVE-EM-PRODUCAO';
app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
const upload=multer({dest:path.join(__dirname,'uploads'),limits:{fileSize:10*1024*1024}});
fs.mkdirSync(path.join(__dirname,'uploads'),{recursive:true});
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','gerente','supervisor','cq','embaladora')),active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS workers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,code TEXT UNIQUE NOT NULL,rate REAL DEFAULT 0,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS production(id INTEGER PRIMARY KEY AUTOINCREMENT,worker_id INTEGER NOT NULL,date TEXT NOT NULL,boxes INTEGER DEFAULT 0,cat1 REAL DEFAULT 0,cat3 REAL DEFAULT 0,industry REAL DEFAULT 0,excess90 REAL DEFAULT 0,notes TEXT,created_by INTEGER,source_value REAL,source_note TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(worker_id) REFERENCES workers(id),FOREIGN KEY(created_by) REFERENCES users(id));`);
try{db.exec("ALTER TABLE production ADD COLUMN source_value REAL")}catch{};try{db.exec("ALTER TABLE production ADD COLUMN source_note TEXT")}catch{};
if(!db.prepare('SELECT 1 FROM users LIMIT 1').get()) db.prepare('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)').run('Administrador','admin',bcrypt.hashSync('admin123',10),'admin');
function auth(req,res,next){try{const h=req.headers.authorization||'';const t=h.startsWith('Bearer ')?h.slice(7):'';req.user=jwt.verify(t,JWT_SECRET);next()}catch(e){res.status(401).json({error:'Não autorizado'})}}
function roles(...rs){return (req,res,next)=>rs.includes(req.user.role)?next():res.status(403).json({error:'Sem permissão'})}
app.post('/api/login',(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(req.body.username);if(!u||!bcrypt.compareSync(req.body.password,u.password))return res.status(401).json({error:'Usuário ou senha inválidos'});const token=jwt.sign({id:u.id,name:u.name,username:u.username,role:u.role},JWT_SECRET,{expiresIn:'12h'});res.json({token,user:{id:u.id,name:u.name,username:u.username,role:u.role}})});
app.get('/api/me',auth,(req,res)=>res.json(req.user));
app.delete('/api/admin/delete-import',auth,roles('admin'),(req,res)=>{
  try{
    const from=String(req.body.from||'');
    const to=String(req.body.to||'');
    if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(from)||!/^\\d{4}-\\d{2}-\\d{2}$/.test(to))
      return res.status(400).json({error:'Informe data inicial e final.'});
    if(from>to)
      return res.status(400).json({error:'A data inicial não pode ser maior que a data final.'});

    const result=db.prepare(`
      DELETE FROM production
      WHERE date>=?
      AND date<=?
      AND notes LIKE 'Importado da planilha:%'
    `).run(from,to);

    res.json({ok:true,deleted:result.changes,from,to});
  }catch(e){
    res.status(500).json({error:'Erro ao apagar importações: '+e.message});
  }
});
app.get('/api/settings',auth,(req,res)=>{const get=k=>Number(db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value);res.json({payment_threshold:Number.isFinite(get('payment_threshold'))?get('payment_threshold'):90,cat_error_limit:Number.isFinite(get('cat_error_limit'))?get('cat_error_limit'):10,industry_error_limit:Number.isFinite(get('industry_error_limit'))?get('industry_error_limit'):6});});
app.put('/api/settings',auth,roles('admin','gerente'),(req,res)=>{const n=Number(req.body.payment_threshold),cat=Number(req.body.cat_error_limit),ind=Number(req.body.industry_error_limit);if(!Number.isFinite(n)||n<0||!Number.isFinite(cat)||cat<0||!Number.isFinite(ind)||ind<0)return res.status(400).json({error:'Parâmetros inválidos'});const up=db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");up.run('payment_threshold',String(n));up.run('cat_error_limit',String(cat));up.run('industry_error_limit',String(ind));res.json({payment_threshold:n,cat_error_limit:cat,industry_error_limit:ind});});
if(!db.prepare("SELECT 1 FROM settings WHERE key='payment_threshold'").get()) db.prepare("INSERT INTO settings(key,value) VALUES('payment_threshold','90')").run();
if(!db.prepare("SELECT 1 FROM settings WHERE key='cat_error_limit'").get()) db.prepare("INSERT INTO settings(key,value) VALUES('cat_error_limit','10')").run();
if(!db.prepare("SELECT 1 FROM settings WHERE key='industry_error_limit'").get()) db.prepare("INSERT INTO settings(key,value) VALUES('industry_error_limit','6')").run();
function payEligible(cat1,cat3,industry){const catLimit=Number(db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'").get()?.value||10);const indLimit=Number(db.prepare("SELECT value FROM settings WHERE key='industry_error_limit'").get()?.value||6);return Number(cat1||0)<=catLimit && Number(cat3||0)<=catLimit && Number(industry||0)<indLimit;}
function paymentFor(boxes,rate,cat1,cat3,industry){const threshold=Number(db.prepare("SELECT value FROM settings WHERE key='payment_threshold'").get()?.value||90);return payEligible(cat1,cat3,industry)?Math.max(Number(boxes||0)-threshold,0)*Number(rate||0):0;}
function paymentReason(cat1,cat3,industry){const catLimit=Number(db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'").get()?.value||10);const indLimit=Number(db.prepare("SELECT value FROM settings WHERE key='industry_error_limit'").get()?.value||6);if(Number(cat1||0)>catLimit)return `Não paga: CAT 1 acima de ${catLimit}%`;if(Number(cat3||0)>catLimit)return `Não paga: CAT 3 acima de ${catLimit}%`;if(Number(industry||0)>=indLimit)return `Não paga: Indústria em ${indLimit}% ou mais`;return 'Elegível para pagamento';}
app.get('/api/workers',auth,(req,res)=>res.json(db.prepare('SELECT * FROM workers ORDER BY name').all()));
app.post('/api/workers',auth,roles('admin','gerente','supervisor'),(req,res)=>{try{const r=db.prepare('INSERT INTO workers(name,code,rate) VALUES(?,?,?)').run(req.body.name,req.body.code,Number(req.body.rate||0));res.json({id:r.lastInsertRowid})}catch(e){res.status(400).json({error:'Código já cadastrado ou dados inválidos'})}});
app.put('/api/workers/:id',auth,roles('admin','gerente','supervisor'),(req,res)=>{db.prepare('UPDATE workers SET name=?,code=?,rate=?,active=? WHERE id=?').run(req.body.name,req.body.code,Number(req.body.rate||0),req.body.active?1:0,req.params.id);res.json({ok:true})});
app.get('/api/users',auth,roles('admin'),(req,res)=>res.json(db.prepare('SELECT id,name,username,role,active,created_at FROM users ORDER BY name').all()));
app.post('/api/users',auth,roles('admin'),(req,res)=>{try{const p=bcrypt.hashSync(req.body.password,10);const r=db.prepare('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)').run(req.body.name,req.body.username,p,req.body.role);res.json({id:r.lastInsertRowid})}catch(e){res.status(400).json({error:'Usuário já existe ou dados inválidos'})}});
app.get('/api/production',auth,(req,res)=>{const {from,to,worker}=req.query;let q=`SELECT p.*,w.name worker_name,w.code,w.rate,CASE WHEN p.cat1<=10 AND p.cat3<=10 AND p.industry<6 THEN MAX(p.boxes-?,0)*w.rate ELSE 0 END payment,CASE WHEN p.cat1>${catLimit} THEN 'Não paga: CAT 1 acima de '+${catLimit}+'%' WHEN p.cat3>${catLimit} THEN 'Não paga: CAT 3 acima de '+${catLimit}+'%' WHEN p.industry>=${indLimit} THEN 'Não paga: Indústria em '+${indLimit}+'% ou mais' ELSE 'Elegível para pagamento' END payment_reason FROM production p JOIN workers w ON w.id=p.worker_id WHERE 1=1`;const a=[];if(from){q+=' AND p.date>=?';a.push(from)}if(to){q+=' AND p.date<=?';a.push(to)}if(worker){q+=' AND p.worker_id=?';a.push(worker)}q+=' ORDER BY p.date DESC,p.id DESC';const threshold=Number(db.prepare("SELECT value FROM settings WHERE key='payment_threshold'").get()?.value||90);const catLimit=Number(db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'").get()?.value||10);const indLimit=Number(db.prepare("SELECT value FROM settings WHERE key='industry_error_limit'").get()?.value||6);q=q.replaceAll('p.cat1<=10','p.cat1<=?').replaceAll('p.cat3<=10','p.cat3<=?').replaceAll('p.industry<6','p.industry<?').replaceAll('p.cat1>10','p.cat1>?').replaceAll('p.cat3>10','p.cat3>?').replaceAll('p.industry>=6','p.industry>=?');res.json(db.prepare(q).all(threshold,catLimit,catLimit,indLimit,catLimit,catLimit,indLimit,...a))});
app.post('/api/production',auth,roles('admin','gerente','supervisor','cq','embaladora'),(req,res)=>{const boxes=Number(req.body.boxes||0),cat1=Number(req.body.cat1||0),cat3=Number(req.body.cat3||0),industry=Number(req.body.industry||0);const threshold=Number(db.prepare("SELECT value FROM settings WHERE key='payment_threshold'").get()?.value||90);const excess=Math.max(boxes-threshold,0);const r=db.prepare('INSERT INTO production(worker_id,date,boxes,cat1,cat3,industry,excess90,notes,created_by,source_value,source_note) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(req.body.worker_id,req.body.date,boxes,cat1,cat3,industry,excess,req.body.notes||'',req.user.id,null,'manual');res.json({id:r.lastInsertRowid,payment_eligible:payEligible(cat1,cat3,industry),payment_reason:paymentReason(cat1,cat3,industry)})});
app.post('/api/import-production',auth,roles('admin','gerente','supervisor','cq'),upload.single('file'),(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Arquivo não enviado'});
  let imported=0,skipped=0,createdWorkers=0; const errors=[];
  try{
    const wb=XLSX.readFile(req.file.path,{cellDates:true});
    const insWorker=db.prepare('INSERT OR IGNORE INTO workers(name,code,rate) VALUES(?,?,?)');
    const getWorker=db.prepare('SELECT id FROM workers WHERE lower(name)=lower(?) LIMIT 1');
    const getByCode=db.prepare('SELECT id FROM workers WHERE code=? LIMIT 1');
    const insProd=db.prepare('INSERT INTO production(worker_id,date,boxes,cat1,cat3,industry,excess90,notes,created_by,source_value,source_note) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const tx=db.transaction(()=>{
      for(const sheet of wb.SheetNames){
        const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,defval:'',raw:true});
        let date=null, headerIdx=-1;
        for(let i=0;i<Math.min(rows.length,8);i++){
          const joined=rows[i].map(v=>String(v||'').toUpperCase()).join(' | ');
          const d=rows[i].find(v=>v instanceof Date || /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(String(v||'')));
          if(d && !date) date=d instanceof Date ? d : parseDate(String(d));
          if(joined.includes('NOMES') && (joined.includes('N° CX')||joined.includes('N°CX')||joined.includes('CX'))) headerIdx=i;
        }
        if(!date){skipped++;continue;} if(headerIdx<0) headerIdx=1;
        const hdr=rows[headerIdx].map(v=>String(v||'').trim().toUpperCase());
        const idx=(terms)=>{for(let i=0;i<hdr.length;i++) if(terms.some(x=>hdr[i].includes(x))) return i;return -1};
        const nameI=idx(['NOMES']), boxesI=idx(['N° CX','N°CX','CX']), cat1I=idx(['CAT 1']), cat3I=idx(['CAT 3']), indI=idx(['INDUSTRIA']), exI=idx(['EXCEDENTE +90']), valI=idx(['VALOR DIA','R$']);
        if(nameI<0||boxesI<0) {skipped++;continue;}
        for(let i=headerIdx+1;i<rows.length;i++){
          const row=rows[i]; const rawName=String(row[nameI]||'').trim(); if(!rawName||rawName.toUpperCase()==='LADO 1') continue;
          const name=rawName.replace(/\s+/g,' ').trim(); let boxes=num(row[boxesI]);
          if(boxes===null || boxes===0){skipped++;continue;}
          let w=getWorker.get(name);
          if(!w){const code='IMP-'+slug(name).slice(0,20)+'-'+Math.random().toString(36).slice(2,6);insWorker.run(name,code,0);w=getWorker.get(name);createdWorkers++;}
          const cat1=percent(row[cat1I]),cat3=percent(row[cat3I]),industry=percent(row[indI]); const threshold=Number(db.prepare("SELECT value FROM settings WHERE key='payment_threshold'").get()?.value||90); const excess=Math.max(boxes-threshold,0);
          const sourceValue=money(row[valI]);
          insProd.run(w.id,dateISO(date),boxes,cat1,cat3,industry,excess,'Importado da planilha: '+sheet,req.user.id,sourceValue,sourceValue!==null?'valor da planilha':''); imported++;
        }
      }
    }); tx();
    res.json({ok:true,imported,skipped,createdWorkers});
  }catch(e){res.status(400).json({error:'Falha ao importar: '+e.message});}
  finally{try{fs.unlinkSync(req.file.path)}catch{}}
});
function num(v){if(v===null||v===undefined||v==='')return null;if(typeof v==='number')return v;let s=String(v).replace(/[^0-9,.-]/g,'').replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',','.');const n=Number(s);return Number.isFinite(n)?n:null}
function percent(v){const n=num(v);if(n===null)return 0;return String(v).includes('%')?n:(n<=1?n*100:n)}
function money(v){if(v===null||v===undefined||v==='')return null;const n=num(v);return n===null?null:n}
function parseDate(s){const m=s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);if(!m)return null;let y=Number(m[3]);if(y<100)y+=2000;return new Date(y,Number(m[2])-1,Number(m[1]))}
function dateISO(d){if(!d)return null;return d.toISOString().slice(0,10)}
function slug(s){return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9]+/g,'-').toUpperCase()}
app.delete('/api/production/:id',auth,roles('admin','gerente'),(req,res)=>{db.prepare('DELETE FROM production WHERE id=?').run(req.params.id);res.json({ok:true})});
// Normaliza registros antigos importados que armazenavam percentuais como fração (0,08 -> 8).
db.prepare("UPDATE production SET cat1=cat1*100 WHERE source_note LIKE 'valor da planilha' AND cat1>0 AND cat1<=1").run(); db.prepare("UPDATE production SET cat3=cat3*100 WHERE source_note LIKE 'valor da planilha' AND cat3>0 AND cat3<=1").run(); db.prepare("UPDATE production SET industry=industry*100 WHERE source_note LIKE 'valor da planilha' AND industry>0 AND industry<=1").run();
app.get('/api/dashboard',auth,(req,res)=>{
  const {from,to}=req.query;
  const where=[]; const args=[];
  if(from){where.push('p.date>=?');args.push(from)}
  if(to){where.push('p.date<=?');args.push(to)}
  const wsql=where.length?' WHERE '+where.join(' AND '):'';
  const threshold=Number(db.prepare("SELECT value FROM settings WHERE key='payment_threshold'").get()?.value||90);
  const catLimit=Number(db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'").get()?.value||10); const indLimit=Number(db.prepare("SELECT value FROM settings WHERE key='industry_error_limit'").get()?.value||6); const eligible=`(p.cat1<=${catLimit} AND p.cat3<=${catLimit} AND p.industry<${indLimit})`;
  const summary=db.prepare(`SELECT COUNT(*) records,COALESCE(SUM(p.boxes),0) boxes,COALESCE(SUM(CASE WHEN ${eligible} THEN MAX(p.boxes-?,0)*w.rate ELSE 0 END),0) payment,COUNT(DISTINCT p.worker_id) workers,COALESCE(SUM(MAX(p.boxes-?,0)),0) excess_boxes,COALESCE(SUM(CASE WHEN ${eligible} THEN 0 ELSE 1 END),0) nonpay_records FROM production p JOIN workers w ON w.id=p.worker_id${wsql}`).get(threshold,threshold,...args);
  const top=db.prepare(`SELECT w.name,w.code,COALESCE(SUM(p.boxes),0) boxes,COALESCE(SUM(MAX(p.boxes-?,0)),0) excess_boxes,COALESCE(SUM(CASE WHEN ${eligible} THEN MAX(p.boxes-?,0)*w.rate ELSE 0 END),0) payment,COALESCE(SUM(CASE WHEN ${eligible} THEN 0 ELSE 1 END),0) nonpay_records FROM workers w LEFT JOIN production p ON p.worker_id=w.id${where.length?' AND '+where.join(' AND '):''} GROUP BY w.id ORDER BY boxes DESC LIMIT 20`).all(threshold,threshold,...args);
  const daily=db.prepare(`SELECT p.date,COUNT(*) records,COUNT(DISTINCT p.worker_id) workers,COALESCE(SUM(p.boxes),0) boxes,COALESCE(SUM(MAX(p.boxes-?,0)),0) excess_boxes,COALESCE(SUM(CASE WHEN ${eligible} THEN MAX(p.boxes-?,0)*w.rate ELSE 0 END),0) payment,COALESCE(SUM(CASE WHEN ${eligible} THEN 0 ELSE 1 END),0) nonpay_records FROM production p JOIN workers w ON w.id=p.worker_id${wsql} GROUP BY p.date ORDER BY p.date DESC`).all(threshold,threshold,...args);
  const details=db.prepare(`SELECT p.date,w.name,w.code,p.boxes,MAX(p.boxes-?,0) excess_boxes,CASE WHEN ${eligible} THEN MAX(p.boxes-?,0)*w.rate ELSE 0 END payment,CASE WHEN p.cat1>${catLimit} THEN 'Não paga: CAT 1 acima de '+${catLimit}+'%' WHEN p.cat3>${catLimit} THEN 'Não paga: CAT 3 acima de '+${catLimit}+'%' WHEN p.industry>=${indLimit} THEN 'Não paga: Indústria em '+${indLimit}+'% ou mais' ELSE 'Elegível para pagamento' END payment_reason FROM production p JOIN workers w ON w.id=p.worker_id${wsql} ORDER BY p.date DESC,p.id DESC LIMIT 500`).all(threshold,threshold,...args);
  res.json({summary,top,daily,details,threshold});
});
app.listen(process.env.PORT||3000,()=>console.log('Packing House em http://localhost:'+(process.env.PORT||3000)));
