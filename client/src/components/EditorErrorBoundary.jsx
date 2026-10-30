import { Component } from 'react'
import { AlertTriangle } from 'lucide-react'

// An editor failure must not blank the whole app: the note list, the outbox
// and every other note stay usable, and the editor can be reopened.
export default class EditorErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Editor crashed', error)
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }
    return (
      <div className="banner banner-error" role="alert">
        <AlertTriangle size={16} />
        <div className="banner-body">
          <strong>The editor stopped working.</strong>
          <span>Changes already handed to the editor are kept on this device. Reopen the note to continue.</span>
          <div className="banner-actions">
            <button type="button" className="btn-primary" onClick={() => this.setState({ error: null })}>
              Reopen note
            </button>
          </div>
        </div>
      </div>
    )
  }
}
