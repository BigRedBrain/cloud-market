import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="w-full max-w-md text-center">
        <p className="text-muted-foreground font-mono text-sm">404</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="bg-primary text-primary-foreground focus-visible:ring-ring mt-8 inline-flex h-10 items-center justify-center rounded-md px-5 text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Back to shop
        </Link>
      </div>
    </main>
  )
}
