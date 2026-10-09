import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center gap-2">
          <Logo />
          <span className="text-[14px] font-semibold tracking-tight">Outbound OS</span>
        </div>
        {children}
      </div>
    </main>
  );
}
