import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Card } from '../components/primitives.tsx';
import { EmptyState } from '../components/states.tsx';

export default function NotFoundPage() {
  return (
    <Card className="mx-auto max-w-xl">
      <h1 className="sr-only">페이지를 찾을 수 없음</h1>
      <EmptyState
        icon={<Compass className="size-8" />}
        title="페이지를 찾을 수 없음"
        description="주소가 바뀌었거나 잘못된 링크일 수 있음."
        action={
          <Link to="/" className="focus-ring rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover">
            대시보드로 이동
          </Link>
        }
      />
    </Card>
  );
}
