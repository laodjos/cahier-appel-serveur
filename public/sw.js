// Service Worker — tourne en arrière-plan dans le navigateur, indépendamment de
// l'onglet de l'application. C'est ce qui permet de recevoir une notification
// même si l'application Cahier d'Appel n'est pas ouverte à l'écran.

self.addEventListener("push", (event) => {
  let donnees = { title: "Cahier d'Appel", body: "Nouvelle notification" };
  try { donnees = event.data.json(); } catch {}

  event.waitUntil(
    self.registration.showNotification(donnees.title || "Cahier d'Appel", {
      body: donnees.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "cahier-appel-rappel-cours", // remplace une notification précédente au lieu de les empiler
    })
  );
});

// Au clic sur la notification, ramène l'utilisateur sur l'application (ou
// l'ouvre si elle n'était pas déjà ouverte dans un onglet).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((tousLesOnglets) => {
      for (const onglet of tousLesOnglets) {
        if ("focus" in onglet) return onglet.focus();
      }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});
