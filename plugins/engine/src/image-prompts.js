export const IMAGE_PROMPT_MODES = {
  scene: "Describe the scene as it stands at the end of this chat: the place, who is there and what they look like, what they are doing, the lighting and the mood.",
  character: "Describe {{char}} as they look right now: build, face, hair, eyes, skin, clothing, accessories, pose and expression, full body.",
  face: "Describe a close-up portrait of {{char}} as they look right now: face, expression, eyes, hair, and what is visible of their clothing. Nothing below the shoulders.",
  user: "Describe {{user}} as {{char}} sees them right now: build, face, hair, clothing, pose and expression, full body.",
  background: "Describe only the place where this scene happens: location, time of day, weather, lighting, notable objects. No people.",
};
export const IMAGE_PROMPT_RULES = [
  "This description goes straight to an image generator. Write one paragraph of plain visual description, present tense, under 120 words.",
  "Describe people by what they look like; the image generator does not know anyone's name.",
  "Leave out dialogue, thoughts, sounds, smells, and anything a camera could not see. Do not continue the story.",
  "Reply with only the description.",
].join(" ");
