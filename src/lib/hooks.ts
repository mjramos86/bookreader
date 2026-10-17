import { useEffect, useState } from 'react';

/** Object URL for a blob, revoked when the blob changes or the component unmounts. */
export function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export function useHashRoute(): { view: 'library' } | { view: 'read'; id: string } {
  const parse = () => {
    const m = /^#\/read\/([\w-]+)/.exec(location.hash);
    return m ? ({ view: 'read', id: m[1] } as const) : ({ view: 'library' } as const);
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  location.hash = hash;
}
