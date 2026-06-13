import { AuthPage } from '../../src/routes/Auth'

export function meta() {
  return [{ title: 'Sign in — Inkwave' }]
}

export default function Login() {
  return <AuthPage />
}
