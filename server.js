const express=require('express');const path=require('path');const fs=require('fs');const Database=require('better-sqlite3');const bcrypt=require('bcryptjs');const jwt=require('jsonwebtoken');const multer=require('multer');const XLSX=require('xlsx');const Tesseract=require('tesseract.js');
const app=express();const db=new Database(path.join(__dirname,'packing.db'));const JWT_SECRET=process.env.JWT_SECRET||'TROQUE-ESTA-CHAVE-EM-PRODUCAO';
app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
const upload=multer({dest:path.join(__dirname,'uploads'),limits:{fileSize:10*1024*1024}});
fs.mkdirSync(path.join(__dirname,'uploads'),{recursive:true});
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','gerente','supervisor','cq','embaladora')),active INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS workers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,code TEXT UNIQUE NOT NULL,rate REAL DEFAULT 0,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS production(id INTEGER PRIMARY KEY AUTOINCREMENT,worker_id INTEGER NOT NULL,date TEXT NOT NULL,boxes INTEGER DEFAULT 0,cat1 REAL DEFAULT 0,cat3 REAL DEFAULT 0,industry REAL DEFAULT 0,excess90 REAL DEFAULT 0,notes TEXT,created_by INTEGER,source_value REAL,source_note TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(worker_id) REFERENCES workers(id),FOREIGN KEY(created_by) REFERENCES users(id));

// MIGRACAO AUTOMATICA - CAT 1
try{
  const productionCols = db
    .prepare("PRAGMA table_info(production)")
    .all()
    .map(c=>c.name);

  if(!productionCols.includes('cat1_sample1')){
    db.exec("ALTER TABLE production ADD COLUMN cat1_sample1 REAL");
    console.log('MIGRACAO: production.cat1_sample1 criada');
  }

  if(!productionCols.includes('cat1_sample2')){
    db.exec("ALTER TABLE production ADD COLUMN cat1_sample2 REAL");
    console.log('MIGRACAO: production.cat1_sample2 criada');
  }

}catch(e){
  console.error('ERRO NA MIGRACAO CAT 1:',e);
}

`);
try{db.exec("ALTER TABLE production ADD COLUMN source_value REAL")}catch{};try{db.exec("ALTER TABLE production ADD COLUMN source_note TEXT")}catch{};
if(!db.prepare('SELECT 1 FROM users LIMIT 1').get()) db.prepare('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)').run('Administrador','admin',bcrypt.hashSync('admin123',10),'admin');
function auth(req,res,next){try{const h=req.headers.authorization||'';const t=h.startsWith('Bearer ')?h.slice(7):'';req.user=jwt.verify(t,JWT_SECRET);next()}catch(e){res.status(401).json({error:'Não autorizado'})}}
function roles(...rs){return (req,res,next)=>rs.includes(req.user.role)?next():res.status(403).json({error:'Sem permissão'})}
app.post('/api/login',(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(req.body.username);if(!u||!bcrypt.compareSync(req.body.password,u.password))return res.status(401).json({error:'Usuário ou senha inválidos'});const token=jwt.sign({id:u.id,name:u.name,username:u.username,role:u.role},JWT_SECRET,{expiresIn:'12h'});res.json({token,user:{id:u.id,name:u.name,username:u.username,role:u.role}})});
app.get('/api/me',auth,(req,res)=>res.json(req.user));
app.delete('/api/admin/delete-import',auth,roles('admin','gerente'),(req,res)=>{
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
      AND (notes LIKE 'Importado da planilha:%' OR notes='Importado por imagem/OCR')
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
function validateCat1(sample1,sample2=null){
  const catLimit=Number(db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'").get()?.value||10);
  const s1=Number(sample1||0);

  // 1ª amostra dentro do limite: aprovado imediatamente.
  // NÃO realiza segunda amostra.
  if(s1<=catLimit){
    return {
      status:'APROVADO',
      sample1:s1,
      sample2:null,
      secondRequired:false,
      paymentEligible:true
    };
  }

  // 1ª amostra acima do limite: exige segunda amostra.
  if(sample2===null || sample2===undefined || sample2===''){
    return {
      status:'SEGUNDA_AMOSTRA',
      sample1:s1,
      sample2:null,
      secondRequired:true,
      paymentEligible:false
    };
  }

  const s2=Number(sample2);

  // 2ª amostra dentro do limite: aprovado.
  if(s2<=catLimit){
    return {
      status:'APROVADO',
      sample1:s1,
      sample2:s2,
      secondRequired:false,
      paymentEligible:true
    };
  }

  // As duas amostras estão acima do limite.
  return {
    status:'REPROVADO',
    sample1:s1,
    sample2:s2,
    secondRequired:false,
    paymentEligible:false
  };
}

function payEligible(cat1,cat3,industry,cat1_sample1=null,cat1_sample2=null){
  const cat=validateCat1(
    cat1_sample1===null ? cat1 : cat1_sample1,
    cat1_sample2
  );

  const catLimit=Number(db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'").get()?.value||10);
  const indLimit=Number(db.prepare("SELECT value FROM settings WHERE key='industry_error_limit'").get()?.value||6);

  return cat.paymentEligible &&
    Number(cat3||0)<=catLimit &&
    Number(industry||0)<indLimit;
}
function paymentFor(boxes,rate,cat1,cat3,industry){
  const threshold=90;
  const paymentRate=0.25;
  return Math.max(Number(boxes||0)-threshold,0)*paymentRate;
}
function paymentReason(cat1,cat3,industry){const catLimit=Number(db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'").get()?.value||10);const indLimit=Number(db.prepare("SELECT value FROM settings WHERE key='industry_error_limit'").get()?.value||6);if(Number(cat1||0)>catLimit)return `Não paga: CAT 1 acima de ${catLimit}%`;if(Number(cat3||0)>catLimit)return `Não paga: CAT 3 acima de ${catLimit}%`;if(Number(industry||0)>=indLimit)return `Não paga: Indústria em ${indLimit}% ou mais`;return 'Elegível para pagamento';}
app.get('/api/workers',auth,(req,res)=>res.json(db.prepare('SELECT * FROM workers ORDER BY name').all()));
app.post('/api/workers',auth,roles('admin','gerente','supervisor'),(req,res)=>{try{const r=db.prepare('INSERT INTO workers(name,code,rate) VALUES(?,?,?)').run(req.body.name,req.body.code,Number(req.body.rate||0));res.json({id:r.lastInsertRowid})}catch(e){res.status(400).json({error:'Código já cadastrado ou dados inválidos'})}});
app.put('/api/workers/:id',auth,roles('admin','gerente','supervisor'),(req,res)=>{db.prepare('UPDATE workers SET name=?,code=?,rate=?,active=? WHERE id=?').run(req.body.name,req.body.code,Number(req.body.rate||0),req.body.active?1:0,req.params.id);res.json({ok:true})});
app.get('/api/users',auth,roles('admin'),(req,res)=>res.json(db.prepare('SELECT id,name,username,role,active,created_at FROM users ORDER BY name').all()));
app.post('/api/users',auth,roles('admin'),(req,res)=>{try{const p=bcrypt.hashSync(req.body.password,10);const r=db.prepare('INSERT INTO users(name,username,password,role) VALUES(?,?,?,?)').run(req.body.name,req.body.username,p,req.body.role);res.json({id:r.lastInsertRowid})}catch(e){res.status(400).json({error:'Usuário já existe ou dados inválidos'})}});
app.get('/api/production',auth,(req,res)=>{
  try{
    const {from,to,worker}=req.query;

    const threshold=Number(
      db.prepare("SELECT value FROM settings WHERE key='payment_threshold'")
        .get()?.value || 90
    );

    const catLimit=Number(
      db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'")
        .get()?.value || 10
    );

    const indLimit=Number(
      db.prepare("SELECT value FROM settings WHERE key='industry_error_limit'")
        .get()?.value || 6
    );

    let q=`
      SELECT
        p.*,
        w.name AS worker_name,
        w.code,
        w.rate,

        CASE
          WHEN p.boxes <= ?
            THEN 0

          WHEN NOT (
            COALESCE(p.cat1_sample1,p.cat1) <= ?
            OR (
              COALESCE(p.cat1_sample1,p.cat1) > ?
              AND p.cat1_sample2 IS NOT NULL
              AND p.cat1_sample2 <= ?
            )
          )
            THEN 0

          WHEN p.cat3 > ?
            THEN 0

          WHEN p.industry >= ?
            THEN 0

          ELSE COALESCE(p.excess90,MAX(p.boxes-?,0))*0.25
        END AS payment,

        CASE
          WHEN p.boxes <= ?
            THEN 'Não atingiu o limite de ' || ? || ' caixas'

          WHEN COALESCE(p.cat1_sample1,p.cat1) > ?
               AND p.cat1_sample2 IS NULL
            THEN 'Aguardando 2ª amostra de CAT 1'

          WHEN COALESCE(p.cat1_sample1,p.cat1) > ?
               AND p.cat1_sample2 > ?
            THEN 'Não paga: 2ª amostra CAT 1 acima de ' || ? || '%'

          WHEN p.cat3 > ?
            THEN 'Não paga: CAT 3 acima de ' || ? || '%'

          WHEN p.industry >= ?
            THEN 'Não paga: Indústria em ' || ? || '% ou mais'

          ELSE 'Elegível para pagamento'
        END AS payment_reason

      FROM production p
      JOIN workers w ON w.id=p.worker_id
      WHERE 1=1
    `;

    const args=[
      // CASE PAYMENT
      threshold,
      catLimit,
      catLimit,
      catLimit,
      catLimit,
      indLimit,
      threshold,

      // CASE PAYMENT REASON
      threshold,
      threshold,
      catLimit,
      catLimit,
      catLimit,
      catLimit,
      catLimit,
      catLimit,
      indLimit,
      indLimit
    ];

    if(from){
      q+=' AND p.date>=?';
      args.push(from);
    }

    if(to){
      q+=' AND p.date<=?';
      args.push(to);
    }

    if(worker){
      q+=' AND p.worker_id=?';
      args.push(worker);
    }

    q+=' ORDER BY p.date DESC,p.id DESC';

    const rows=db.prepare(q).all(...args);

    res.json(rows);

  }catch(e){
    console.error('Erro em /api/production:',e);
    res.status(500).json({
      error:'Erro ao carregar produção',
      details:e.message
    });
  }
});

app.post('/api/production',auth,roles('admin','gerente','supervisor','cq','embaladora'),(req,res)=>{
  try{
    const boxes=Number(req.body.boxes||0);

    const cat1_sample1=Number(
      req.body.cat1_sample1 ?? req.body.cat1 ?? 0
    );

    const cat1_sample2=
      req.body.cat1_sample2===undefined ||
      req.body.cat1_sample2===null ||
      req.body.cat1_sample2===''
        ? null
        : Number(req.body.cat1_sample2);

    const cat3=Number(req.body.cat3||0);
    const industry=Number(req.body.industry||0);

    const threshold=Number(
      db.prepare("SELECT value FROM settings WHERE key='payment_threshold'")
        .get()?.value||90
    );

    const catLimit=Number(
      db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'")
        .get()?.value||10
    );

    const indLimit=Number(
      db.prepare("SELECT value FROM settings WHERE key='industry_error_limit'")
        .get()?.value||6
    );

    const validation=validateCat1(
      cat1_sample1,
      cat1_sample2
    );

    const excess=Math.max(boxes-threshold,0);

    const eligible=
      boxes>threshold &&
      validation.paymentEligible &&
      cat3<=catLimit &&
      industry<indLimit;

    const r=db.prepare(`
      INSERT OR IGNORE INTO production(
        worker_id,
        date,
        boxes,
        cat1,
        cat1_sample1,
        cat1_sample2,
        cat3,
        industry,
        excess90,
        notes,
        created_by,
        source_value,
        source_note
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.body.worker_id,
      req.body.date,
      boxes,
      cat1_sample1,
      cat1_sample1,
      cat1_sample2,
      cat3,
      industry,
      excess,
      req.body.notes||'',
      req.user.id,
      null,
      'manual'
    );

    let payment_reason='Elegível para pagamento';

    if(boxes<=threshold){
      payment_reason='Não atingiu o limite de '+threshold+' caixas';
    }else if(validation.status==='SEGUNDA_AMOSTRA'){
      payment_reason='Aguardando 2ª amostra de CAT 1';
    }else if(validation.status==='REPROVADO'){
      payment_reason='Não paga: 2ª amostra CAT 1 acima de '+catLimit+'%';
    }else if(cat3>catLimit){
      payment_reason='Não paga: CAT 3 acima de '+catLimit+'%';
    }else if(industry>=indLimit){
      payment_reason='Não paga: Indústria em '+indLimit+'% ou mais';
    }

    res.json({
      id:r.lastInsertRowid,
      payment_eligible:eligible,
      payment_reason:payment_reason,
      cat1_status:validation.status,
      cat1_sample1:cat1_sample1,
      cat1_sample2:cat1_sample2,
      second_sample_required:validation.secondRequired
    });

  }catch(e){
    console.error(e);
    res.status(400).json({
      error:'Falha ao lançar produção: '+e.message
    });
  }
});
app.post('/api/ocr-production',auth,roles('admin','gerente','supervisor','cq'),upload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Imagem não enviada'});

  try{
    const result=await Tesseract.recognize(
      req.file.path,
      'por',
      {
        logger:m=>{
          if(m.status==='recognizing text' && m.progress){
            console.log('OCR:',Math.round(m.progress*100)+'%');
          }
        }
      }
    );

    const text=result.data.text||'';


    
    res.json({
      ok:true,
      text
    });

  }catch(e){
    res.status(400).json({
      error:'Falha no OCR: '+e.message
    });
  }finally{
    try{fs.unlinkSync(req.file.path)}catch{}
  }
});


app.post('/api/import-image-production',auth,roles('admin','gerente','supervisor','cq'),upload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Imagem não enviada'});

  try{
    const result=await Tesseract.recognize(
      req.file.path,
      'por',
      {
        logger:m=>{
          if(m.status==='recognizing text' && m.progress){
            console.log('OCR:',Math.round(m.progress*100)+'%');
          }
        }
      }
    );

    const text=result.data.text||'';
    const rows=parseOCRProduction(text);

    if(!rows.length){
      return res.status(400).json({
        error:'Nenhum registro de produção foi identificado na imagem.',
        ocr_text:text
      });
    }

    const insWorker=db.prepare(
      'INSERT OR IGNORE INTO workers(name,code,rate) VALUES(?,?,?)'
    );

    const getWorker=db.prepare(
      'SELECT id FROM workers WHERE lower(name)=lower(?) LIMIT 1'
    );

    const insProd=db.prepare(`
      INSERT INTO production(
        worker_id,date,boxes,cat1,cat3,industry,
        excess90,notes,created_by,source_value,source_note
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `);

    const threshold=Number(
      db.prepare(
        "SELECT value FROM settings WHERE key='payment_threshold'"
      ).get()?.value || 90
    );

    let imported=0;
    let createdWorkers=0;

    const tx=db.transaction(()=>{
      for(const row of rows){

        if(!row.date || !row.name || !row.boxes) continue;

        let w=getWorker.get(row.name);

        if(!w){
          const code='OCR-'+slug(row.name).slice(0,20)+'-'+
            Math.random().toString(36).slice(2,6);

          insWorker.run(row.name,code,0);
          w=getWorker.get(row.name);
          createdWorkers++;
        }

        const excess=Math.max(
          Number(row.boxes)-threshold,
          0
        );

        const sourceValue=
          row.source_value!==null &&
          Number.isFinite(Number(row.source_value))
            ? Number(row.source_value)
            : null;

        insProd.run(
          w.id,
          row.date,
          Number(row.boxes),
          Number(row.cat1||0),
          Number(row.cat3||0),
          Number(row.industry||0),
          excess,
          'Importado por imagem/OCR',
          req.user.id,
          sourceValue,
          'Importado por imagem/OCR'
        );

        imported++;
      }
    });

    tx();

    res.json({
      ok:true,
      imported,
      createdWorkers,
      rows,
      ocr_text:text
    });

  }catch(e){
    console.error(e);

    res.status(400).json({
      error:'Falha ao importar imagem: '+e.message
    });

  }finally{
    try{fs.unlinkSync(req.file.path)}catch{}
  }
});

app.post('/api/import-production',auth,roles('admin','gerente','supervisor','cq'),upload.single('file'),(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Arquivo não enviado'});
  let imported=0,skipped=0,createdWorkers=0; const errors=[];
  try{
    const wb=XLSX.readFile(req.file.path,{cellDates:true});
    const insWorker=db.prepare('INSERT OR IGNORE INTO workers(name,code,rate) VALUES(?,?,?)');
    const getWorker=db.prepare('SELECT id FROM workers WHERE lower(name)=lower(?) LIMIT 1');
    const getByCode=db.prepare('SELECT id FROM workers WHERE code=? LIMIT 1');
    const insProd=db.prepare('INSERT OR IGNORE INTO production(worker_id,date,boxes,cat1,cat3,industry,excess90,notes,created_by,source_value,source_note) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
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
          const name=rawName.replace(/\s+/g,' ').trim();

          // Ignora linhas de total da planilha.
          // O total deve ser calculado pelo sistema a partir das embaladoras.
          if(/^TOTAL(?:\s+(?:GERAL|DO DIA|DO MÊS|DO MES))?$/i.test(name)){
            skipped++;
            continue;
          }

          let boxes=num(row[boxesI]);
          if(boxes===null || boxes===0){skipped++;continue;}
          let w=getWorker.get(name);
          if(!w){const code='IMP-'+slug(name).slice(0,20)+'-'+Math.random().toString(36).slice(2,6);insWorker.run(name,code,0);w=getWorker.get(name);createdWorkers++;}
          const cat1=percent(row[cat1I]),cat3=percent(row[cat3I]),industry=percent(row[indI]); const threshold=Number(db.prepare("SELECT value FROM settings WHERE key='payment_threshold'").get()?.value||90); const excess=Math.max(boxes-threshold,0);
          const sourceValue=money(row[valI]);
          const result=insProd.run(w.id,dateISO(date),boxes,cat1,cat3,industry,excess,'Importado da planilha: '+sheet,req.user.id,sourceValue,sourceValue!==null?'valor da planilha':'');
          if(result.changes===1) imported++;
          else skipped++;
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

app.put('/api/production/:id',auth,roles('admin','gerente','supervisor'),(req,res)=>{
  try{
    const boxes=Number(req.body.boxes||0);
    const cat1=Number(req.body.cat1||0);
    const cat3=Number(req.body.cat3||0);
    const industry=Number(req.body.industry||0);

    const threshold=Number(
      db.prepare("SELECT value FROM settings WHERE key='payment_threshold'")
        .get()?.value || 90
    );

    const excess=Math.max(boxes-threshold,0);

    db.prepare(`
      UPDATE production
      SET worker_id=?,
          date=?,
          boxes=?,
          cat1=?,
          cat3=?,
          industry=?,
          excess90=?,
          notes=?
      WHERE id=?
    `).run(
      req.body.worker_id,
      req.body.date,
      boxes,
      cat1,
      cat3,
      industry,
      excess,
      req.body.notes||'',
      req.params.id
    );

    res.json({ok:true});
  }catch(e){
    res.status(400).json({
      error:'Erro ao editar produção: '+e.message
    });
  }
});

app.delete('/api/production/:id',auth,roles('admin','gerente'),(req,res)=>{db.prepare('DELETE FROM production WHERE id=?').run(req.params.id);res.json({ok:true})});
// Normaliza registros antigos importados que armazenavam percentuais como fração (0,08 -> 8).
db.prepare("UPDATE production SET cat1=cat1*100 WHERE source_note LIKE 'valor da planilha' AND cat1>0 AND cat1<=1").run(); db.prepare("UPDATE production SET cat3=cat3*100 WHERE source_note LIKE 'valor da planilha' AND cat3>0 AND cat3<=1").run(); db.prepare("UPDATE production SET industry=industry*100 WHERE source_note LIKE 'valor da planilha' AND industry>0 AND industry<=1").run();
app.get('/api/dashboard',auth,(req,res)=>{
  try{
    const {from,to}=req.query;

    const threshold=Number(
      db.prepare("SELECT value FROM settings WHERE key='payment_threshold'")
        .get()?.value || 90
    );

    const catLimit=Number(
      db.prepare("SELECT value FROM settings WHERE key='cat_error_limit'")
        .get()?.value || 10
    );

    const indLimit=Number(
      db.prepare("SELECT value FROM settings WHERE key='industry_error_limit'")
        .get()?.value || 6
    );

    const where=[];
    const args=[];

    if(from){
      where.push('p.date>=?');
      args.push(from);
    }

    if(to){
      where.push('p.date<=?');
      args.push(to);
    }

    const filter=where.length ? ' AND '+where.join(' AND ') : '';

    const eligible=`
      p.boxes > ${threshold}
      AND p.cat1 <= ${catLimit}
      AND p.cat3 <= ${catLimit}
      AND p.industry < ${indLimit}
    `;

    const excess=`
      CASE
        WHEN ${eligible}
        THEN COALESCE(p.excess90,MAX(p.boxes-${threshold},0))
        ELSE 0
      END
    `;

    const payment=`
      CASE
        WHEN ${eligible}
        THEN COALESCE(p.excess90,MAX(p.boxes-${threshold},0))*0.25
        ELSE 0
      END
    `;

    const reason=`
      CASE
        WHEN p.boxes <= ${threshold}
          THEN 'Não atingiu o limite de ${threshold} caixas'
        WHEN p.cat1 > ${catLimit}
          THEN 'Não paga: CAT 1 acima de ${catLimit}%'
        WHEN p.cat3 > ${catLimit}
          THEN 'Não paga: CAT 3 acima de ${catLimit}%'
        WHEN p.industry >= ${indLimit}
          THEN 'Não paga: Indústria em ${indLimit}% ou mais'
        ELSE 'Elegível para pagamento'
      END
    `;

    const summary=db.prepare(`
      SELECT
        COUNT(*) AS records,
        COALESCE(SUM(p.boxes),0) AS boxes,
        COALESCE(SUM(${excess}),0) AS excess_boxes,
        COALESCE(SUM(${payment}),0) AS payment,
        COUNT(DISTINCT p.worker_id) AS workers,
        COALESCE(SUM(
          CASE WHEN ${eligible} THEN 0 ELSE 1 END
        ),0) AS nonpay_records
      FROM production p
      JOIN workers w ON w.id=p.worker_id
      WHERE 1=1${filter}
    `).get(...args);

    const top=db.prepare(`
      SELECT
        w.name,
        w.code,
        COALESCE(SUM(p.boxes),0) AS boxes,
        COALESCE(SUM(${excess}),0) AS excess_boxes,
        COALESCE(SUM(${payment}),0) AS payment,
        COALESCE(SUM(
          CASE WHEN ${eligible} THEN 0 ELSE 1 END
        ),0) AS nonpay_records
      FROM workers w
      LEFT JOIN production p
        ON p.worker_id=w.id${filter}
      GROUP BY w.id
      HAVING COUNT(p.id)>0
      ORDER BY boxes DESC
    `).all(...args);

    const daily=db.prepare(`
      SELECT
        p.date,
        COUNT(*) AS records,
        COUNT(DISTINCT p.worker_id) AS workers,
        COALESCE(SUM(p.boxes),0) AS boxes,
        COALESCE(SUM(${excess}),0) AS excess_boxes,
        COALESCE(SUM(${payment}),0) AS payment,
        COALESCE(SUM(
          CASE WHEN ${eligible} THEN 0 ELSE 1 END
        ),0) AS nonpay_records
      FROM production p
      JOIN workers w ON w.id=p.worker_id
      WHERE 1=1${filter}
      GROUP BY p.date
      ORDER BY p.date DESC
    `).all(...args);

    const details=db.prepare(`
      SELECT
        p.id,
        p.date,
        w.name,
        w.code,
        p.boxes,
        p.cat1,
        p.cat3,
        p.industry,
        ${excess} AS excess_boxes,
        ${payment} AS payment,
        ${reason} AS payment_reason
      FROM production p
      JOIN workers w ON w.id=p.worker_id
      WHERE 1=1${filter}
      ORDER BY p.date DESC,p.id DESC
      LIMIT 500
    `).all(...args);

    res.json({
      summary,
      top,
      daily,
      details,
      threshold,
      catLimit,
      indLimit
    });

  }catch(e){
    console.error('Erro no dashboard:',e);

    res.status(500).json({
      error:'Erro ao carregar dashboard: '+e.message
    });
  }
});

app.listen(process.env.PORT||3000,()=>console.log('Packing House em http://localhost:'+(process.env.PORT||3000)));
