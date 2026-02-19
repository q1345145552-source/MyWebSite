"use client";

type StepGuideProps = {
  steps: string[];
  completedSteps?: number[];
};

export default function StepGuide({ steps, completedSteps = [] }: StepGuideProps) {
  return (
    <div className="step-guide">
      {steps.map((step, idx) => (
        <div
          className={`step-item ${completedSteps.includes(idx) ? "step-item-done" : ""}`}
          key={`${idx}-${step}`}
        >
          <span className="step-index">{idx + 1}</span>
          <span>{step}</span>
          {completedSteps.includes(idx) ? <span className="step-check">✓</span> : null}
        </div>
      ))}
    </div>
  );
}
