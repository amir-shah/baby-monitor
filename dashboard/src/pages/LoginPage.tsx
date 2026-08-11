import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, describeError, ThemeToggle } from '../components';
import { auth } from '../lib/api';
import './LoginPage.css';

/**
 * Sign-in.
 *
 * Outside the app shell: there is no navigation to offer until there is a
 * session. The redirect target is carried in `?next=` so a deep link (a push
 * notification opening a specific night, say) survives the detour.
 */
export function LoginPage() {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const next = search.get('next') ?? '/';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await auth.login(password);
      // `replace` so Back does not land on the login form again.
      navigate(next, { replace: true });
    } catch (cause) {
      const described = describeError(cause);
      setError(described.description ?? described.title);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      <div className="login__toggle">
        <ThemeToggle />
      </div>

      <main className="login__panel">
        <h1 className="login__title">babymon</h1>
        <p className="login__subtitle">Sign in to see the nursery.</p>

        <form className="login__form" onSubmit={onSubmit}>
          <label className="field__label" htmlFor="login-password">
            Password
          </label>
          <input
            id="login-password"
            className="input"
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
          />

          {error ? (
            <p className="login__error" id="login-error" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" size="lg" block loading={submitting}>
            Sign in
          </Button>
        </form>
      </main>
    </div>
  );
}
