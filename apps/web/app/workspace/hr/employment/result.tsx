"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";

interface EmploymentResultProps {
  readonly message: string;
  readonly success: boolean;
}

export function EmploymentResult({ message, success }: EmploymentResultProps) {
  const result = useRef<HTMLDivElement>(null);
  const resultIdentity = `${success ? "success" : "failure"}:${message}`;
  useEffect(() => {
    if (resultIdentity) result.current?.focus();
  }, [resultIdentity]);
  return (
    <div
      className={success ? "success-banner" : "form-error-summary"}
      id="employment-result"
      ref={result}
      role={success ? "status" : "alert"}
      tabIndex={-1}
    >
      {success ? (
        <CircleCheck aria-hidden="true" size={20} />
      ) : (
        <TriangleAlert aria-hidden="true" size={20} />
      )}
      <p>{message}</p>
    </div>
  );
}
