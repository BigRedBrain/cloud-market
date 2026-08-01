'use client'

import { AuthForm } from '@/components/auth/auth-form'
import { Field, Input } from '@/components/ui/field'
import {
  changePasswordAction,
  signInAction,
  signUpAction,
  updateProfileAction,
} from '@/lib/auth/actions'
import {
  completePasswordResetAction,
  confirmEmailAction,
  requestPasswordResetAction,
  resendVerificationAction,
} from '@/lib/auth/email-actions'
import { MINIMUM_AGE_YEARS, PASSWORD_MIN_LENGTH } from '@/lib/auth/validation'

/**
 * The concrete authentication forms.
 *
 * All Client Components, because they hold form state — but note that none of
 * them import the DAL or read the session. Session data is resolved in a Server
 * Component and passed down as props, which `server-only` enforces at build
 * time.
 *
 * `autoComplete` values are deliberate: they are what let a password manager
 * offer to save and fill credentials correctly, and getting `new-password` vs
 * `current-password` wrong is a common reason managers silently misbehave.
 */

export function SignInForm({ next }: { next?: string }) {
  return (
    <AuthForm action={signInAction} submitLabel="Sign in" pendingLabel="Signing in">
      {(errors) => (
        <>
          {next && <input type="hidden" name="next" value={next} />}

          <Field id="email" label="Email" error={errors?.email?.[0]} required>
            {(props) => (
              <Input
                type="email"
                name="email"
                autoComplete="email"
                autoFocus
                {...props}
              />
            )}
          </Field>

          <Field id="password" label="Password" error={errors?.password?.[0]} required>
            {(props) => (
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                {...props}
              />
            )}
          </Field>
        </>
      )}
    </AuthForm>
  )
}

export function SignUpForm() {
  return (
    <AuthForm action={signUpAction} submitLabel="Create account" pendingLabel="Creating account">
      {(errors) => (
        <>
          <Field id="name" label="Full name" error={errors?.name?.[0]} required>
            {(props) => (
              <Input name="name" autoComplete="name" autoFocus {...props} />
            )}
          </Field>

          <Field id="email" label="Email" error={errors?.email?.[0]} required>
            {(props) => <Input type="email" name="email" autoComplete="email" {...props} />}
          </Field>

          <Field
            id="dateOfBirth"
            label="Date of birth"
            hint={`You must be ${MINIMUM_AGE_YEARS} or older. We verify ID at handoff.`}
            error={errors?.dateOfBirth?.[0]}
            required
          >
            {(props) => (
              <Input type="date" name="dateOfBirth" autoComplete="bday" {...props} />
            )}
          </Field>

          <Field
            id="password"
            label="Password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters. Longer beats complicated.`}
            error={errors?.password?.[0]}
            required
          >
            {(props) => (
              <Input type="password" name="password" autoComplete="new-password" {...props} />
            )}
          </Field>
        </>
      )}
    </AuthForm>
  )
}

export function ChangePasswordForm() {
  return (
    <AuthForm
      action={changePasswordAction}
      submitLabel="Change password"
      pendingLabel="Changing password"
      successMessage="Password changed. Every other device has been signed out."
    >
      {(errors) => (
        <>
          <Field
            id="currentPassword"
            label="Current password"
            error={errors?.currentPassword?.[0]}
            required
          >
            {(props) => (
              <Input
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                {...props}
              />
            )}
          </Field>

          <Field
            id="newPassword"
            label="New password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            error={errors?.newPassword?.[0]}
            required
          >
            {(props) => (
              <Input
                type="password"
                name="newPassword"
                autoComplete="new-password"
                {...props}
              />
            )}
          </Field>

          <Field
            id="confirmPassword"
            label="Confirm new password"
            error={errors?.confirmPassword?.[0]}
            required
          >
            {(props) => (
              <Input
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                {...props}
              />
            )}
          </Field>
        </>
      )}
    </AuthForm>
  )
}

export function ProfileForm({
  defaultName,
  defaultPhone,
}: {
  defaultName: string
  defaultPhone: string
}) {
  return (
    <AuthForm
      action={updateProfileAction}
      submitLabel="Save changes"
      pendingLabel="Saving"
      successMessage="Your details have been updated."
    >
      {(errors) => (
        <>
          <Field id="name" label="Full name" error={errors?.name?.[0]} required>
            {(props) => (
              <Input name="name" autoComplete="name" defaultValue={defaultName} {...props} />
            )}
          </Field>

          <Field
            id="phone"
            label="Phone"
            hint="The driver texts this number on arrival."
            error={errors?.phone?.[0]}
          >
            {(props) => (
              <Input
                type="tel"
                name="phone"
                autoComplete="tel"
                defaultValue={defaultPhone}
                {...props}
              />
            )}
          </Field>
        </>
      )}
    </AuthForm>
  )
}

/**
 * Requests a password reset link.
 *
 * Deliberately has no success/failure branch of its own: the action always
 * redirects to the same confirmation page, so this form cannot become the place
 * where a difference between "sent" and "no such account" leaks out.
 */
export function ForgotPasswordForm() {
  return (
    <AuthForm
      action={requestPasswordResetAction}
      submitLabel="Email me a reset link"
      pendingLabel="Sending"
    >
      {(errors) => (
        <Field id="email" label="Email" error={errors?.email?.[0]} required>
          {(props) => (
            <Input type="email" name="email" autoComplete="email" autoFocus {...props} />
          )}
        </Field>
      )}
    </AuthForm>
  )
}

/**
 * Sets a new password from a reset link.
 *
 * The token rides in a hidden field because a Server Action receives form data,
 * not route params. It is not a leak — it is already in the address bar of the
 * page being looked at.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  return (
    <AuthForm
      action={completePasswordResetAction}
      submitLabel="Set new password"
      pendingLabel="Saving"
    >
      {(errors) => (
        <>
          <input type="hidden" name="token" value={token} />

          <Field
            id="password"
            label="New password"
            error={errors?.password?.[0]}
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            required
          >
            {(props) => (
              <Input
                type="password"
                name="password"
                autoComplete="new-password"
                autoFocus
                {...props}
              />
            )}
          </Field>

          <Field
            id="confirmPassword"
            label="Confirm new password"
            error={errors?.confirmPassword?.[0]}
            required
          >
            {(props) => (
              <Input type="password" name="confirmPassword" autoComplete="new-password" {...props} />
            )}
          </Field>
        </>
      )}
    </AuthForm>
  )
}

/** Resends the confirmation email. One button, no fields. */
export function ResendVerificationForm() {
  return (
    <AuthForm
      action={resendVerificationAction}
      submitLabel="Send the confirmation email"
      pendingLabel="Sending"
      successMessage="Confirmation email sent. Check your inbox, and your spam folder."
    >
      {() => null}
    </AuthForm>
  )
}

/**
 * Confirms an email address.
 *
 * A form, not a link. The emailed URL only ever renders this button; the
 * verification happens when the customer submits it. That is what keeps a mail
 * scanner's GET from confirming an address nobody has looked at yet.
 */
export function ConfirmEmailForm({ token }: { token: string }) {
  return (
    <AuthForm
      action={confirmEmailAction}
      submitLabel="Confirm my email address"
      pendingLabel="Confirming"
    >
      {() => <input type="hidden" name="token" value={token} />}
    </AuthForm>
  )
}
