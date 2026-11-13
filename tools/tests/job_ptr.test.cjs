const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../../src/storage/job_ptr.h'),'utf8');
function body(marker){const begin=source.indexOf('{',source.indexOf(marker));let n=0;for(let i=begin;i<source.length;i++){if(source[i]==='{')n++;if(source[i]==='}'&&!--n)return source.slice(begin,i+1);}throw Error(marker);}
const js=s=>s.replace(/->/g,'.').replace(/nullptr/g,'null').replace(/\bjob_\b/g,'this.job_')
 .replace('delete this.job_;','destroy(this.job_);').replace('std::swap(this.job_, other.this.job_);','[this.job_,other.job_]=[other.job_,this.job_];')
 .replace(/other.this.job_/g,'other.job_');
function harness(){let destroyed=0;
 const Lease=new Function('destroy',`return class {
 constructor(job=null,mode='copy'){this.job_=job instanceof this.constructor?job.job_:job;
  if(mode==='move')job.job_=null;else this.retain();}
 retain()${js(body('void retain('))}
 swap(other)${js(body('void swap('))}
 dispose()${js(body('~JobPtr('))}
 }`)(job=>{assert.equal(job.refs,0);destroyed++;job.finish?.();});
 function job(){return {refs:0,references:{fetch_add(n){return this.owner.refs+=n;},fetch_sub(n){const old=this.owner.refs;this.owner.refs-=n;return old;},owner:null}};}
 const create=()=>{const j=job();j.references.owner=j;return j;};
 return {Lease,create,destroyed:()=>destroyed};
}

test('queue, callback and preparing ownership survive either disconnect ordering without a second allocation',()=>{
 for(const order of [[0,1,2],[2,0,1],[1,2,0]]){
  const h=harness(),j=h.create(),producer=new h.Lease(j),queue=new h.Lease(producer),callback=new h.Lease(producer);
  producer.dispose();const main=new h.Lease(queue,'move');assert.equal(queue.job_,null);assert.equal(j.refs,2);
  const handles=[callback,main,queue];for(const index of order){handles[index].dispose();if(j.refs)assert.equal(h.destroyed(),0);}
  assert.equal(h.destroyed(),1);assert.equal(j.refs,0);
 }
 assert.doesNotMatch(source,/make_shared|malloc|new /);
});

test('swapping a popped lease never destroys a job while the queue mutex is held; empty and self copies are safe',()=>{
 const h=harness(),j=h.create(),queue=new h.Lease(j),main=new h.Lease();let inCritical=false;
 j.finish=()=>assert.equal(inCritical,false);
 inCritical=true;main.swap(queue);inCritical=false;assert.equal(queue.job_,null);assert.equal(main.job_,j);
 const selfCopy=new h.Lease(main);selfCopy.swap(main);selfCopy.dispose();assert.equal(h.destroyed(),0);
 queue.dispose();main.dispose();assert.equal(h.destroyed(),1);
});
