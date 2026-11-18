import type {ReactNode} from "react";

export function AuthFrame({children}:{children:ReactNode}){
 return <div className="wormhole-entry">
  <div className="wormhole-entry-art" aria-hidden="true" />
  <header className="wormhole-entry-header">
   <div className="wormhole-entry-brand"><img src="/brand/logo-light.svg?v=2" className="wormhole-brand-wordmark" alt="WORMHOLE" width={755} height={280}/></div>
  </header>
  <main className="wormhole-entry-main">
   <section className="wormhole-entry-card" aria-label="Account login">{children}</section>
  </main>

 </div>;
}
