interface Props {
  loggedIn: boolean
  waiting: number | null
  onLogin: () => void
  onCancelLogin: () => void
  onLogout: () => void
}

export function LoginPanel({ loggedIn, waiting, onLogin, onCancelLogin, onLogout }: Props) {
  if (waiting !== null) {
    return (
      <span className="auth waiting">
        等待扫码中… {waiting}s
        <button className="btn-mini" onClick={onCancelLogin}>取消</button>
      </span>
    )
  }
  if (loggedIn) {
    return (
      <span className="auth auth-ok">
        ● 已登录
        <button className="btn-mini" onClick={onLogout}>退出登录</button>
      </span>
    )
  }
  return (
    <span className="auth auth-no">
      ● 未登录
      <button className="btn-mini" onClick={onLogin}>扫码登录</button>
    </span>
  )
}
