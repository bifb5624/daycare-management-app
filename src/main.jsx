import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// ★ ErrorBoundary: アプリ内で発生した未処理エラーをキャッチし、
//    全画面エラー (コード5 等) でアプリ全体が落ちるのを防ぐ。
//    fallback UI でリロード + エラー詳細を表示。
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    try { console.error('[ErrorBoundary]', error, info); } catch {}
  }
  render() {
    if (this.state.error) {
      const message = (this.state.error && (this.state.error.message || String(this.state.error))) || '不明なエラー';
      const stack = (this.state.info && this.state.info.componentStack) || '';
      return (
        <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',padding:24,background:'#fef2f2',fontFamily:'"Hiragino Sans","Yu Gothic",sans-serif'}}>
          <div style={{maxWidth:540,width:'100%',background:'white',borderRadius:20,boxShadow:'0 10px 40px rgba(0,0,0,0.08)',padding:32}}>
            <div style={{fontSize:40,marginBottom:12,textAlign:'center'}}>⚠️</div>
            <h1 style={{fontSize:18,fontWeight:'bold',color:'#991b1b',marginBottom:8,textAlign:'center'}}>画面の表示中に問題が発生しました</h1>
            <p style={{fontSize:13,color:'#64748b',lineHeight:1.7,marginBottom:14,textAlign:'center'}}>
              ご迷惑をおかけしております。<br/>
              下のボタンから再読み込みをお試しください。
            </p>
            <div style={{background:'#fef2f2',border:'1px solid #fecaca',borderRadius:10,padding:'10px 14px',marginBottom:18}}>
              <div style={{fontSize:11,fontWeight:'bold',color:'#991b1b',marginBottom:4}}>エラー内容</div>
              <div style={{fontSize:12,color:'#7f1d1d',fontFamily:'monospace',wordBreak:'break-all'}}>{message}</div>
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'center'}}>
              <button onClick={()=>window.location.reload()} style={{padding:'10px 24px',background:'#2563eb',color:'white',border:'none',borderRadius:10,fontSize:13,fontWeight:'bold',cursor:'pointer'}}>🔄 再読み込み</button>
              <button onClick={()=>{ try{sessionStorage.clear();}catch{} window.location.href='/'; }} style={{padding:'10px 16px',background:'#f1f5f9',color:'#475569',border:'1px solid #cbd5e1',borderRadius:10,fontSize:13,fontWeight:'bold',cursor:'pointer'}}>ログイン画面へ</button>
            </div>
            {stack && (
              <details style={{marginTop:14,fontSize:11,color:'#94a3b8'}}>
                <summary style={{cursor:'pointer',userSelect:'none'}}>技術情報 (開発者用)</summary>
                <pre style={{whiteSpace:'pre-wrap',marginTop:8,background:'#f8fafc',padding:10,borderRadius:8,fontSize:10,maxHeight:200,overflow:'auto'}}>{stack}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
