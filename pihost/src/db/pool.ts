import { Pool } from "pg";
const backgroundPools=new WeakMap<Pool,Pool>();
/** Background projection cannot occupy execution/control connections. */
export function backgroundPool(pool:Pool):Pool{return backgroundPools.get(pool)??pool;}

export function createPool(dsn: string): Pool {
  if (!dsn) {
    throw new Error("[db] database.dsn is missing (see /var/lib/wormhole/config.json for the runtime configuration file)");
  }
  const pool=new Pool({connectionString:dsn,max:10,connectionTimeoutMillis:5000,
    statement_timeout:30000,lock_timeout:5000,application_name:'wormhole-execution'});
  pool.on('error',error=>console.error('[execution-db]',error.message));
  const background=new Pool({connectionString:dsn,max:2,connectionTimeoutMillis:2000,
    statement_timeout:5000,lock_timeout:1000,application_name:'wormhole-projection'});
  background.on('error',error=>console.error('[projection-db]',error.message));
  backgroundPools.set(pool,background);
  const end=pool.end.bind(pool);
  pool.end=(async()=>{await background.end();await end();}) as Pool['end'];
  return pool;
}
