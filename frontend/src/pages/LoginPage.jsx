import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate, useLocation } from 'react-router-dom'

import Input  from '../components/ui/Input'
import Button from '../components/ui/Button'
import Alert  from '../components/ui/Alert'
import Logo   from '../components/Logo'
import { useAuth } from '../context/AuthContext'

const ROLE_HOME = {
  owner:   '/dashboard',
  admin:   '/dashboard',
  manager: '/dashboard',
  cashier: '/sells',
}

export default function LoginPage() {
  const { login } = useAuth()
  const navigate  = useNavigate()
  const location  = useLocation()
  const from      = location.state?.from?.pathname ?? null

  const [serverError, setServerError] = useState('')
  const [loading, setLoading]         = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({ mode: 'onTouched' })

  const onSubmit = async ({ email, password }) => {
    setServerError('')
    setLoading(true)
    try {
      const profile = await login(email.trim(), password)
      const dest    = from ?? ROLE_HOME[profile.role] ?? '/dashboard'
      navigate(dest, { replace: true })
    } catch (err) {
      const fe = err?.errors
      let detail = ''
      if (fe && typeof fe === 'object') {
        if (fe.detail)      detail = Array.isArray(fe.detail) ? fe.detail[0] : String(fe.detail)
        else if (fe.non_field_errors) {
          detail = Array.isArray(fe.non_field_errors) ? fe.non_field_errors[0] : String(fe.non_field_errors)
        }
      }
      setServerError(
        detail
          || (err.message && err.message !== 'Validation failed.' ? err.message : '')
          || 'Login failed. Please check your credentials.'
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-navy-900 px-4 py-12 overflow-hidden">
      {/* Ambient gradient glows */}
      <div className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full bg-brand-600/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-cyan-500/20 blur-3xl" />

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo variant="icon" size="2xl" />
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-white">
            NSL<span className="text-brand-400">·</span>POS
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Sign in to your workspace
          </p>
        </div>

        <div className="rounded-2xl bg-white shadow-2xl ring-1 ring-black/5 p-8 sm:p-10">
          <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-5">
            {serverError && <Alert type="error">{serverError}</Alert>}

            <Input
              label="Email address"
              type="email"
              placeholder="you@company.com"
              autoComplete="username"
              inputMode="email"
              required
              error={errors.email?.message}
              leftIcon={
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M2.5 5.5A2.5 2.5 0 015 3h10a2.5 2.5 0 012.5 2.5v9A2.5 2.5 0 0115 17H5a2.5 2.5 0 01-2.5-2.5v-9zm2.2-.5l5.3 3.86L15.3 5H4.7zM16 6.7l-5.4 3.94a1 1 0 01-1.2 0L4 6.7v7.8c0 .55.45 1 1 1h10c.55 0 1-.45 1-1V6.7z" />
                </svg>
              }
              {...register('email', {
                required: 'Email is required.',
                pattern: {
                  value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                  message: 'Enter a valid email address.',
                },
              })}
            />

            <Input
              label="Password"
              type="password"
              placeholder="••••••••••••"
              autoComplete="current-password"
              required
              error={errors.password?.message}
              leftIcon={
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                </svg>
              }
              {...register('password', {
                required: 'Password is required.',
                minLength: { value: 6, message: 'Password must be at least 6 characters.' },
              })}
            />

            <Button type="submit" fullWidth loading={loading} size="lg" className="mt-1">
              Sign in
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-[11px] text-slate-500">
          © {new Date().getFullYear()} NSL-POS
        </p>
      </div>
    </div>
  )
}
