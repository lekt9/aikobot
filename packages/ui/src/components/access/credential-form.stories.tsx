/** Reviewed credential sheet states contain no prefilled secrets or model-generated values. */
/// <reference types="vite/client" />
import type { Meta, StoryObj } from "@storybook/react";
import { CredentialForm } from "./credential-form";
import { fixtureRequest } from "./fixtures";
import "./access.css";

const meta = {
  title: "Access/Credential form",
  component: CredentialForm,
  decorators: [
    (Story) => (
      <div className="access-sheet">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CredentialForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Password: Story = {
  args: {
    accountSite: fixtureRequest.site,
    request: fixtureRequest,
    onSubmit: async () => {
      throw new Error("Story has no connected vault");
    },
    onCancel: () => undefined,
  },
};
export const Verification: Story = {
  args: {
    ...Password.args,
    request: {
      ...fixtureRequest,
      spec: {
        ...fixtureRequest.spec,
        elements: {
          ...fixtureRequest.spec.elements,
          password: {
            type: "SecretField",
            props: {
              ref: "vault://example.com/password",
              kind: "code",
              label: "Verification code",
            },
            children: [],
          },
        },
      },
    },
  },
};
export const Expired: Story = {
  args: { ...Password.args, request: { ...fixtureRequest, expiresAt: 1 } },
};
