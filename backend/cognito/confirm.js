const Cognito = require("@aws-sdk/client-cognito-identity-provider");

const clientId = "your client ID goes here"; // match signUp.js
const username = "myusername";  // Match signUp.js
const confirmationCode = "your confirmation code goes here"; // obtain from your email

async function main() {
    const client = new Cognito.CognitoIdentityProviderClient({ region: 'ap-southeast-2' });
  const command2 = new Cognito.ConfirmSignUpCommand({
    ClientId: clientId,
    Username: username,
    ConfirmationCode: confirmationCode,
  });

  res2 = await client.send(command2);
  console.log(res2);

}

main();
