import ReactDOM from 'react-dom/client'
// Installs window.custos for the browser. Must come before anything that
// touches it -- in Electron the preload has already provided the identical
// surface, which is what lets one component tree serve both.
import './custos-api'
import App from './App'
import './styles.css'

// Deliberately no <React.StrictMode> -- its dev-only double-invoke of
// effects (mount -> cleanup -> mount) races against ChatTerminal opening a
// real WebSocket via IPC: the second mount's redundant open call closes
// the first mount's socket, and the resulting close event lands on
// whichever listener happens to be registered at that moment, which can
// be the second (still-current) instance. Effects here have real,
// non-idempotent side effects (opening PTYs on a remote server), not pure
// rendering, so the double-invoke check buys little and actively breaks
// this flow.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
