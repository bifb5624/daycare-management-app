import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// ★ 真っ白(白画面)対策: 描画時エラーを画面に表示して原因を特定できるようにする
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, info: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { this.setState({ info }); console.error('[App crashed]', error, info); }
  render() {
    if (this.state.error) {
      const e = this.state.error;
      const msg = (e && (e.stack || e.message)) || String(e);
      const comp = this.state.info?.componentStack || '';
      return (
        <div style={{padding:20,fontFamily:'system-ui',color:'#0f172a',background:'#fff',minHeight:'100vh',boxSizing:'border-box'}}>
          <div style={{fontWeight:'bold',fontSize:18,color:'#dc2626',marginBottom:8}}>⚠️ 画面の表示中にエラーが発生しました</div>
          <div style={{fontSize:13,color:'#475569',marginBottom:12}}>下の内容をスクリーンショットで送ってください。原因を特定して修正します。</div>
          <button onClick={()=>{ try{ localStorage.clear(); sessionStorage.clear(); }catch(_e){} location.reload(); }}
            style={{marginBottom:12,padding:'8px 14px',background:'#2563eb',color:'#fff',border:'none',borderRadius:8,fontWeight:'bold',cursor:'pointer'}}>
            データをクリアして再読み込み
          </button>
          <pre style={{whiteSpace:'pre-wrap',fontSize:11,background:'#f1f5f9',border:'1px solid #cbd5e1',borderRadius:8,padding:12,overflow:'auto',maxHeight:'40vh'}}>{msg}</pre>
          {comp && <pre style={{whiteSpace:'pre-wrap',fontSize:11,background:'#fef2f2',border:'1px solid #fecaca',borderRadius:8,padding:12,overflow:'auto',maxHeight:'30vh',marginTop:8}}>{comp}</pre>}
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
