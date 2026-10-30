fetch("/api/auth").then((r) => r.json()).then((a) => { document.getElementById("skip").hidden = !!a.authRequired; }).catch(() => {});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = document.getElementById("loginError");
  const button = document.getElementById("loginBtn");
  error.textContent = "";
  button.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: document.getElementById("username").value, password: document.getElementById("password").value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Could not sign in");
    location.replace("/");
  } catch (err) {
    error.textContent = err.message;
    document.getElementById("password").value = "";
    button.disabled = false;
  }
});
