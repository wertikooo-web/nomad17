window.NOMAD17_RUN_ENDPOINT = "https://nomad17-run.wertikooo.workers.dev";

window.addEventListener("DOMContentLoaded", () => {
  const password = document.getElementById("runPassword");
  if (!password) return;

  password.setAttribute("autocomplete", "new-password");
  password.value = "";

  const clearPassword = () => {
    password.value = "";
    setTimeout(() => {
      password.value = "";
      password.focus();
    }, 30);
  };

  document.getElementById("runNow")?.addEventListener("click", clearPassword, true);
  document.getElementById("missionBtn")?.addEventListener("click", clearPassword, true);
  document.getElementById("cancelRun")?.addEventListener("click", () => { password.value = ""; });
});
