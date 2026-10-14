"use client"; export default function Error({reset}:{error:Error;reset:()=>void}){return <main><h1>予期しないエラーが発生しました</h1><button onClick={reset}>再試行</button></main>;}
