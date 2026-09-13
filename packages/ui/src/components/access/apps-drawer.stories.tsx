/** Interactive Apps drawer states use deterministic HTTP fixtures and the real Access SDK. */
/// <reference types="vite/client" />
import type { Meta, StoryObj } from "@storybook/react";
import { AppsDrawer } from "./apps-drawer";
import {
  createDrawerFixture,
  fixtureConnection,
  fixtureRequest,
} from "./fixtures";
import "./access.css";

const meta = {
  title: "Access/Apps drawer",
  component: AppsDrawer,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AppsDrawer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {
  args: { client: createDrawerFixture(null).client },
};
export const ReadyToConnect: Story = {
  args: { client: createDrawerFixture().client },
};
export const SignInNeeded: Story = {
  args: {
    client: createDrawerFixture({
      ...fixtureConnection,
      status: "credentials_required",
      pending: fixtureRequest,
    }).client,
  },
};
export const Connected: Story = {
  args: {
    client: createDrawerFixture({
      ...fixtureConnection,
      status: "connected",
      verifiedAt: 1789257600000,
    }).client,
  },
};
