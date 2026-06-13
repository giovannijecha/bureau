import { Clock } from "lucide-react";

export function ComingSoon({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <h1 className="text-base font-semibold leading-none">{title}</h1>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Clock className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-semibold">Coming soon</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{blurb}</p>
      </div>
    </div>
  );
}
