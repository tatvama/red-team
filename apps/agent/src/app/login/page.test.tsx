import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateTo } from "@/lib/client/navigation";
import { jsonResponse } from "@/test/fixtures";
import LoginPage from "./page";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

describe("LoginPage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.mocked(navigateTo).mockClear();
  });

  async function signIn(token: string) {
    render(<LoginPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Sign in to Tatvam" })).toBeInTheDocument();
    const input = screen.getByLabelText("Access token");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.type(input, token);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    return input;
  }

  it("goes to the app after a 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await signIn("secret-token");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ token: "secret-token" });
    expect(navigateTo).toHaveBeenCalledWith("/");
  });

  it("says the token is wrong after a 401, without redirecting", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));
    const input = await signIn("wrong");
    expect(await screen.findByRole("alert")).toHaveTextContent("That token is not correct.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveFocus();
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("asks to wait after a 429", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Slow down" }, 429));
    await signIn("again");
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts. Wait a few minutes.");
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("shows the server's message for other failures", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Sign-in is not configured on this server." }, 404));
    await signIn("token");
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in is not configured on this server.");
  });

  it("keeps the button disabled until a token is entered", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });
});
