const wait=ms=>new Promise(r=>setTimeout(r,ms));
// Read-only WhatsApp queries are safe to retry. Approval writes are never wrapped here.
export async function retryRead(fn,sleep=wait){
  for(let attempt=0;;attempt++){
    try{return await fn();}catch(error){
      const status=Number(error.output?.statusCode||error.statusCode||0);
      if(attempt>=2||[400,401,403,404].includes(status))throw error;
      await sleep(1000*2**attempt);
    }
  }
}
