/** Private-browser presentation stories use fictional HTTP frames and the real Access SDK. */
/// <reference types="vite/client" />
import type { Meta, StoryObj } from "@storybook/react";
import { createBrowserFixture, fixtureHandoff } from "./browser-fixtures";
import { BrowserHandoff } from "./browser-handoff";
import "./access.css";

const meta = {
  title: "Access/Private browser",
  component: BrowserHandoff,
  decorators: [
    (Story) => (
      <div className="access-apps">
        <Story />
      </div>
    ),
  ],
  args: {
    accountId: "example",
    handoff: fixtureHandoff,
    onResumed: async () => undefined,
  },
} satisfies Meta<typeof BrowserHandoff>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Waiting: Story = {
  args: { client: createBrowserFixture().client },
};
export const Expired: Story = {
  args: {
    client: createBrowserFixture().client,
    handoff: { ...fixtureHandoff, status: "expired", expiresAt: 0 },
  },
};
export const Unavailable: Story = {
  args: {
    client: createBrowserFixture(async () =>
      Response.json({ error: "unavailable" }, { status: 503 }),
    ).client,
  },
};
export const KeyboardOnly: Story = {
  args: {
    client: createBrowserFixture().client,
    handoff: { ...fixtureHandoff, capabilities: ["press", "resume"] },
  },
};
