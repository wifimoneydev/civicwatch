CivicWatch

CivicWatch is an Android app for reporting incidents in your community. You can submit a report with a category, location and an optional photo. Other signed in users can see it immediately and receive an alert while they have the app open.

I built it for the Bincom Mobile App Development assessment. I wanted to keep it simple to use, while giving it a real backend and testing the main flows properly.

Try the app
Install the APK included with this submission on an Android phone running Android 7.0 or newer. If Android asks, allow installation from the app you used to open the APK. This is a debug APK for assessment, rather than a Play Store release.

You need an internet connection. The submitted APK is already connected to my Supabase project, so you do not need to set up a backend to try it.

If an older CivicWatch installation prevents the update, uninstall that version and install the submitted APK again. This clears its saved login. You can check the installed version and commit under App diagnostics, available from the login screen and Profile.

Create an account
Choose Sign up and enter your email and a password with at least eight characters, including a letter and a number. If the app asks you to check your email, confirm your address, then return to CivicWatch and log in.
Your session is saved, so you normally stay logged in when you reopen the app. Use Profile to check your account or log out.

Find reports
The Incidents screen shows the latest reports first. Choose a category to narrow the list, use Load more for older reports, or Refresh to reload it.
Categories include Accident, Fighting, Rioting, Fire, Theft and Other. Tap a report to see its description, photo, time and coordinates. The back arrow returns you to the list.

Reports are published automatically and labelled Unverified. This means someone has submitted the information; it has not been confirmed as fact.

Submit a report
1. Open Report.
2. Add a title, description and category.
3. Tap Use my location, or enter the incident's latitude and longitude manually. Use your current location only if you are at the incident.
4. Optionally, take a photo or choose one from your gallery. You can preview, remove or replace it before submitting.
5. Tap Submit report and wait for confirmation.
The saved report appears in My Reports and the shared feed. My Reports contains only the reports submitted by your account.

If a request fails, the form keeps your input so you can try again. For assessment testing, please use a harmless photo and a title such as Test report to avoid confusing it with a real incident.

Test notifications independently
You need two different accounts and two separate sessions. You can use two phones, or a phone and the browser version described below. For browser testing alone, use two different browsers or a normal window and a private window.

1. Log in as account B and leave the Incidents screen open.
2. Log in as account A in the other session and submit a report.
3. Account B should receive a notification banner and see the report appear in the feed.
4. Tap the banner to open the report. Check that it also appears under its category.
5. Account A should not receive a notification for its own report.
Notifications work while CivicWatch is open and on screen. When you return after being away, the feed refreshes to pick up reports you missed. It does not replay missed notification banners.
Alerts while the app is closed need a separate push notification service and server setup. I kept that outside this MVP so I could focus on the reporting flow and the assessment requirements.

How I built it

The interface uses HTML, CSS and JavaScript, packaged for Android with Apache Cordova. Cordova plugins connect the app to the phone's camera, gallery and GPS.
Supabase handles email login, the PostgreSQL database, photo storage and live updates. I chose it because those services fit this app well and were straightforward for me to connect and manage in one place. WordPress was optional in the brief, so I used Supabase for this version.

The Android APK is built through GitHub Actions. The Supabase JavaScript library is bundled inside the app rather than downloaded when it starts.

I built the app in stages: the Android shell, backend setup, authentication, reporting, then the shared feed and notifications. Along the way, I checked validation, access rules, failed requests, session changes and repeated taps on Submit. I also manually tested the 
completed app on my phone.

Run the source locally

Use the full repository for development:
https://github.com/wifimoneydev/civicwatch
Install Node.js and npm, then run:
git clone https://github.com/wifimoneydev/civicwatch.git
cd civicwatch
npm ci
npm run serve
Open http://localhost:8080. The browser supports reporting, image selection and location access when permission is granted. The Android APK is needed to check the native camera, gallery and Android navigation.
The app configuration is in www/js/config.js. To use your own Supabase project:
1. Create the project and run supabase/migrations/001_incidents_storage_realtime.sql in its SQL Editor.
2. Enter your Project URL and publishable key in www/js/config.js.
3. Enable email authentication and configure the confirmation redirect for your environment.
4. Run npm run check:supabase to check the connection.
Only a publishable key belongs in the app. Do not add a secret key, service role key or database password.
Checks and builds

Command	Purpose
npm test	Local checks for validation, sessions, database policies, reporting and feed logic.
npm run test:e2e	Browser tests. Most backend responses and live events are simulated; some authentication checks contact Supabase.

npm run check:supabase	Checks the configured backend connection.
npm run check:policies	Checks access rules using two real accounts.
npm run check:report	Checks a real report and photo submission.
npm run check:realtime	Checks live delivery between two real accounts.


The account based scripts ask for credentials privately and clean up their temporary test data. Automated checks support the manual tests; they do not replace testing camera, GPS and other device behaviour on a phone.
To build another APK, push to main or run Build Android APK from GitHub Actions. Download the civicwatch-debug-apk artifact from the successful run and extract the APK. Java and the Android SDK are supplied by the cloud workflow, so I did not need to install them on my Mac.
Data and current limits
Signed in users can browse reports and submit under their own account. Database policies prevent them from submitting as another user, editing reports or changing verification status. Users can delete their own reports at the database level; there is no report editing feature in the app.
Incident coordinates are visible to other signed in users. Photos have public URLs, so anyone with an exact photo link can open it. Images are resized and saved as JPEG with hidden metadata removed before upload. Please avoid uploading sensitive material.
This version does not include background push notifications, maps, search, password reset or an in app moderation dashboard. It requires a working internet connection and an available Supabase project.

Daniel Awofadeju
https://danielawofadeju.com