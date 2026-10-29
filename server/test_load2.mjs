import { getSession } from './loadModel.js';
console.log('calling getSession...');
getSession().then(s => {
  console.log('Session loaded:', s.outputNames);
}).catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
