const Cognito = require("@aws-sdk/client-cognito-identity-provider");

const clientId = "7rf6bdj8j4c8cptleaa8g26a1u";  // Obtain from the AWS console
const username = "12345678";
const password = "12345678";
const email = "your email address goes here";

async function main() {
  console.log("Signing up user");
  const client = new Cognito.CognitoIdentityProviderClient({ region: 'ap-southeast-2' });
  const command = new Cognito.SignUpCommand({
    ClientId: clientId,
    Username: username,
    Password: password,
    UserAttributes: [{ Name: "email", Value: email }],
  });
  const res = await client.send(command);
  console.log(res);
}

main();
