import { FlaskConical } from 'lucide-react';
import { useDataset } from '../../data/hooks.ts';

/** Persistent, non-dismissible banner while the synthetic sample is shown (SPEC: never mix sample and real). */
export function SampleBanner() {
  const { isSample, source } = useDataset();
  if (!isSample) return null;
  return (
    <div role="status" className="border-b-2 border-sample-line bg-sample-bg px-4 py-2 text-[13px] text-sample sm:px-6">
      <p className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-2 gap-y-0.5">
        <FlaskConical className="size-4 shrink-0" aria-hidden />
        <strong className="font-bold">샘플 데이터</strong>
        <span>합성 데이터로 만든 예시 화면이며 실제 플랫폼 수치가 아님.</span>
        <span className="opacity-80">
          실데이터를 보려면 수집기에서 <code className="font-mono">npm run collect</code> 후 <code className="font-mono">npm run export</code> 실행.
        </span>
        {source.fallbackReason ? <span className="w-full text-xs opacity-75">({source.fallbackReason})</span> : null}
      </p>
    </div>
  );
}
