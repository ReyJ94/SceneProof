import { AccountIdentity } from "sceneproof-test-auth";
import { defineReactFixture } from "../../src/react-fixture.js";

import "./ContextualCard.css";

function ContextualCard() {
  return (
    <main className="sceneproof-shell">
      <section className="contextual-card" data-sceneproof-id="contextual-card">
        <strong>Production owner</strong>
        <AccountIdentity />
      </section>
    </main>
  );
}

export const contextualCardFixture = defineReactFixture({
  document: {
    html: { classes: ["dark"] },
  },
  render: () => <ContextualCard />,
});
