import "@google/model-viewer"
import { useEffect, useRef, useState, type DetailedHTMLProps, type HTMLAttributes } from "react"
import { ArrowDownRight, ArrowUpRight, Copy, Radio, Settings2 } from "lucide-react"

interface ModelViewerElement extends HTMLElement {
  cameraOrbit: string
  jumpCameraToGoal: () => void
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": DetailedHTMLProps<HTMLAttributes<ModelViewerElement>, ModelViewerElement> & {
        src?: string
        poster?: string
        alt?: string
        exposure?: string
        "camera-controls"?: boolean
        "auto-rotate"?: boolean
        "rotation-per-second"?: string
        "interaction-prompt"?: string
        "shadow-intensity"?: string
      }
    }
  }
}

type Connection = "connecting" | "live" | "offline"

export function LandingPage(props: { connection: Connection; error?: string; onOpenSettings: () => void }): JSX.Element {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle")
  const [signalLive, setSignalLive] = useState(false)

  const copyInstall = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText("npm install -g observer-ai && observer install all")
      setCopied("done")
    } catch {
      setCopied("failed")
    }
    window.setTimeout(() => setCopied("idle"), 2200)
  }

  return (
    <main className="landing-page">
      <nav className="landing-nav" aria-label="Main navigation">
        <a className="landing-brand" href="#top" aria-label="Observer home">
          <span className="landing-brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span>OBSERVER</span>
        </a>
        <div className="landing-nav-links"><a href="#signal">Signal</a><a href="#roster">Roster</a><a href="#install">Install</a></div>
        <div className="landing-nav-actions">
          <span className={`landing-connection landing-connection-${props.connection}`}><span className="landing-connection-dot" />{props.connection === "live" ? "connected" : props.connection}</span>
          <button className="landing-icon-button" type="button" onClick={props.onOpenSettings} aria-label="Open settings"><Settings2 size={16} aria-hidden="true" /></button>
        </div>
      </nav>

      {props.error && <div className="landing-notice" role="status"><Radio size={15} aria-hidden="true" /><span>Signal is quiet — the landing page is still online. {props.error}</span></div>}

      <section className="landing-hero" id="top">
        <div className="landing-hero-copy">
          <p className="landing-kicker">A nervous system for your agent stack</p>
          <h1><span>Watch</span><span className="landing-outline-word">the swarm</span><span>think.</span></h1>
          <p className="landing-dek">Observer turns every delegated thought into a visible, living system. See who is working, why they were seated, and where the whole crew is going next.</p>
          <div className="landing-hero-actions">
            <a className="landing-primary-button" href="#install">Plug into the signal <ArrowDownRight size={17} aria-hidden="true" /></a>
            <button className={`landing-secondary-button${signalLive ? " is-live" : ""}`} type="button" onClick={() => setSignalLive((value) => !value)} aria-pressed={signalLive}>
              <span className="landing-button-pulse" aria-hidden="true" />{signalLive ? "Signal received" : "Wake the demo"}
            </button>
          </div>
          <div className="landing-proof"><span>OPEN SOURCE</span><span>LOCAL FIRST</span><span>14 SPECIALISTS</span></div>
        </div>
        <div className={`landing-hero-art${signalLive ? " is-live" : ""}`} role="group" aria-label="Interactive 3D model of an antique pocket watch">
          <div className="landing-art-stamp">LIVE / 3D ASSET / CC0</div>
          <ObserverWatch active={signalLive} />
          <div className="landing-art-caption"><span>THE OBSERVER EYE</span><span>drag to inspect / use controls</span></div>
          <div className="landing-art-crosshair landing-art-crosshair-a" aria-hidden="true" />
          <div className="landing-art-crosshair landing-art-crosshair-b" aria-hidden="true" />
        </div>
      </section>

      <div className="landing-marquee" aria-hidden="true"><div><span>DELEGATE WITH INTENT</span><i>✳</i><span>SEE THE WHOLE SYSTEM</span><i>✳</i><span>DELEGATE WITH INTENT</span><i>✳</i><span>SEE THE WHOLE SYSTEM</span><i>✳</i></div></div>

      <section className="landing-signal-section" id="signal">
        <div className="landing-section-heading"><p className="landing-kicker">Not another activity log</p><h2>Your agents are a <em>team.</em> Give them a stage.</h2></div>
        <div className="landing-signal-grid">
          <div className="landing-signal-intro"><span className="landing-index">01</span><p>The root agent delegates. Employees appear. Threads fork. Observer makes that choreography legible while it is still happening.</p><a href="#install" className="landing-text-link">Start watching <ArrowUpRight size={15} aria-hidden="true" /></a></div>
          <div className="landing-signal-diagram" role="img" aria-label="A live agent graph with one root agent and three specialist agents">
            <div className="diagram-line diagram-line-main" /><div className="diagram-line diagram-line-left" /><div className="diagram-line diagram-line-right" />
            <span className="diagram-node diagram-node-root"><b>ROOT</b><small>planning</small></span><span className="diagram-node diagram-node-left"><b>SOFIA</b><small>design</small></span><span className="diagram-node diagram-node-center"><b>MALIK</b><small>backend</small></span><span className="diagram-node diagram-node-right"><b>NIA</b><small>security</small></span>
            <span className="diagram-packet packet-one" /><span className="diagram-packet packet-two" />
          </div>
        </div>
      </section>

      <section className="landing-roster-section" id="roster">
        <div className="landing-roster-copy"><p className="landing-kicker">The roster</p><h2>Fourteen sharp minds. <span>Zero beige avatars.</span></h2><p>Every subagent gets a face, a voice, and a reason to be in the room. The matcher reads the task and seats the best fit — without pretending it knows more than it does.</p><div className="landing-roster-tags"><span>FRONTEND</span><span>SECURITY</span><span>DATA</span><span>QA</span><span>DEVOPS</span></div></div>
        <div className="landing-portrait-stack" aria-label="A selection of Observer employee portraits"><img src="/roster/06_sofia_moreno_lead_product_designer.png" alt="Sofia Moreno, lead product designer" loading="lazy" decoding="async" /><img src="/roster/02_malik_johnson_staff_backend_engineer.png" alt="Malik Johnson, staff backend engineer" loading="lazy" decoding="async" /><img src="/roster/05_nia_okafor_senior_cybersecurity_engineer.png" alt="Nia Okafor, senior cybersecurity engineer" loading="lazy" decoding="async" /><div className="landing-portrait-note">THE ROOM<br />IS NEVER EMPTY</div></div>
      </section>

      <section className="landing-install-section" id="install">
        <div><p className="landing-kicker">Make the invisible visible</p><h2>Install the <span>watchtower.</span></h2></div>
        <div className="landing-install-card"><span className="landing-install-prompt">$</span><code>npm install -g observer-ai && observer install all</code><button type="button" onClick={() => void copyInstall()} aria-label="Copy install command"><Copy size={16} aria-hidden="true" />{copied === "done" ? "Copied" : copied === "failed" ? "Select + copy" : "Copy"}</button></div>
        <p className="landing-install-footnote" aria-live="polite">{copied === "failed" ? "Clipboard access is unavailable. Select the command above to copy it manually." : "Works with OpenCode, Codex, Claude Code, and GitHub Copilot CLI."}<span> No cloud relay. No mystery meat.</span></p>
      </section>

      <footer className="landing-footer"><span>OBSERVER / 0.9.16</span><span>CC0 POCKET WATCH / POLY HAVEN</span><span>MADE FOR PEOPLE WHO RUN AGENTS</span><a href="#top">BACK TO TOP ↑</a></footer>
    </main>
  )
}

function ObserverWatch(props: { active: boolean }): JSX.Element {
  const viewerRef = useRef<ModelViewerElement>(null)
  const [failed, setFailed] = useState(false)
  const [paused, setPaused] = useState(!props.active)

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const onError = (): void => setFailed(true)
    viewer.addEventListener("error", onError)
    return () => viewer.removeEventListener("error", onError)
  }, [])

  useEffect(() => setPaused(!props.active), [props.active])

  const rotate = (amount: number): void => {
    const viewer = viewerRef.current
    if (!viewer) return
    const current = Number.parseFloat(viewer.cameraOrbit) || 0
    viewer.cameraOrbit = `${current + amount}deg 75deg 2.8m`
    viewer.jumpCameraToGoal()
  }

  return <div className="landing-model-wrap">
    {failed ? <div className="landing-model-fallback"><img src="/models/pocket-watch/poster.png" alt="Antique brass pocket watch, local fallback for the Observer 3D model" /><span>3D preview unavailable — the watch is still keeping time.</span></div> : <model-viewer ref={viewerRef} className="landing-model-viewer" src="/models/pocket-watch/pocket_watch_1k.gltf" poster="/models/pocket-watch/poster.png" alt="Interactive 3D model of an antique brass pocket watch" exposure="1.15" camera-controls auto-rotate={!paused} rotation-per-second="18deg" interaction-prompt="none" shadow-intensity="1" />}
    <div className="landing-model-controls" aria-label="3D model controls"><button type="button" disabled={failed} onClick={() => rotate(-25)} aria-label="Rotate watch left">←</button><button type="button" disabled={failed} onClick={() => setPaused((value) => !value)} aria-pressed={paused}>{paused ? "PLAY" : "PAUSE"}</button><button type="button" disabled={failed} onClick={() => rotate(25)} aria-label="Rotate watch right">→</button></div>
  </div>
}
