/**
 * Breed catalog for the Fantasy Dog Draft.
 *
 * Source: the full AKC breed list by group (205 breeds as of Jan 1, 2026,
 * including the 2026 additions: Basset Fauve de Bretagne, Teddy Roosevelt
 * Terrier, Russian Tsvetnaya Bolonka). Breeds that show as separate
 * "varieties" at the National Dog Show (Beagle sizes, Dachshund coats, Cocker
 * colors, Collie coats, Chihuahua coats, English Toy Spaniel colors, Bull
 * Terrier colors, Poodle sizes, Manchester Terrier sizes) are listed
 * separately because each variety sends its own Best of Breed into the group.
 *
 * Fields:
 *   name  - display name
 *   wiki  - optional Wikipedia article title used to find a photo when the
 *           display name is ambiguous (e.g. "Boxer" is not only a dog)
 *   blurb - a short plain-English description for non-dog people
 *
 * IDs are derived from the name with slugify() so they are stable as long as
 * names do not change. Do not rename a breed after people have made picks.
 */

export const GROUPS = [
  { key: 'sporting', name: 'Sporting', color: '#2E7D32' },
  { key: 'hound', name: 'Hound', color: '#8D5524' },
  { key: 'working', name: 'Working', color: '#1565C0' },
  { key: 'terrier', name: 'Terrier', color: '#C62828' },
  { key: 'toy', name: 'Toy', color: '#AD1457' },
  { key: 'non-sporting', name: 'Non-Sporting', color: '#6A1B9A' },
  { key: 'herding', name: 'Herding', color: '#EF6C00' },
];

const RAW = {
  sporting: [
    ['American Water Spaniel', 'American Water Spaniel', 'Brown, curly-coated duck hunter from Wisconsin'],
    ['Barbet', 'Barbet (dog)', 'Shaggy French water dog with a beard'],
    ['Boykin Spaniel', '', 'Chocolate-brown turkey hunter from South Carolina'],
    ['Bracco Italiano', '', 'Droopy-faced Italian pointing dog'],
    ['Brittany', 'Brittany dog', 'Peppy orange-and-white bird dog'],
    ['Chesapeake Bay Retriever', '', 'Rugged, wavy-coated duck retriever'],
    ['Clumber Spaniel', '', 'Heavy, low, white spaniel with a big head'],
    ['Cocker Spaniel (ASCOB)', 'American Cocker Spaniel', 'Classic Cocker in any solid color other than black'],
    ['Cocker Spaniel (Black)', 'American Cocker Spaniel', 'Classic long-eared Cocker, solid black'],
    ['Cocker Spaniel (Parti-Color)', 'American Cocker Spaniel', 'Classic Cocker with white patches'],
    ['Curly-Coated Retriever', '', 'Tall retriever covered in tight curls'],
    ['English Cocker Spaniel', '', 'Slightly taller, working-style Cocker'],
    ['English Setter', '', 'Elegant speckled bird dog'],
    ['English Springer Spaniel', '', 'Friendly, energetic liver-and-white spaniel'],
    ['Field Spaniel', '', 'Calm, dark, medium-sized spaniel'],
    ['Flat-Coated Retriever', '', 'Glossy black, forever-puppy retriever'],
    ['German Shorthaired Pointer', '', 'Athletic, spotted all-purpose hunter'],
    ['German Wirehaired Pointer', '', 'Bearded, wiry-coated pointer'],
    ['Golden Retriever', '', 'America\'s friendly golden family dog'],
    ['Gordon Setter', '', 'Black-and-tan Scottish setter'],
    ['Irish Red and White Setter', '', 'Red-and-white cousin of the Irish Setter'],
    ['Irish Setter', '', 'Flashy, mahogany-red long-haired setter'],
    ['Irish Water Spaniel', '', 'Curly brown clown with a rat-like tail'],
    ['Labrador Retriever', '', 'The classic Lab, America\'s favorite'],
    ['Lagotto Romagnolo', '', 'Curly Italian truffle-hunting dog'],
    ['Nederlandse Kooikerhondje', '', 'Orange-and-white Dutch duck decoy dog'],
    ['Nova Scotia Duck Tolling Retriever', '', 'Small red retriever that lures ducks'],
    ['Pointer', 'Pointer (dog breed)', 'Sleek, short-haired classic bird dog'],
    ['Spinone Italiano', '', 'Shaggy, gentle Italian hunting dog'],
    ['Sussex Spaniel', '', 'Long, low, golden-liver spaniel'],
    ['Vizsla', '', 'Sleek, rusty-gold Hungarian pointer'],
    ['Weimaraner', '', 'Silver-gray "gray ghost" hunting dog'],
    ['Welsh Springer Spaniel', '', 'Red-and-white Welsh spaniel'],
    ['Wirehaired Pointing Griffon', '', 'Scruffy, bearded bird dog'],
    ['Wirehaired Vizsla', '', 'Vizsla with a wiry coat and beard'],
  ],
  hound: [
    ['Afghan Hound', '', 'Glamorous sighthound with long silky hair'],
    ['American English Coonhound', '', 'Speckled raccoon-hunting hound'],
    ['American Foxhound', '', 'Lean, long-legged fox hunter'],
    ['Azawakh', '', 'Very thin, elegant African sighthound'],
    ['Basenji', '', 'The "barkless" dog with a curled tail'],
    ['Basset Fauve de Bretagne', '', 'Small, scruffy fawn hound (new in 2026)'],
    ['Basset Hound', '', 'Long ears, short legs, droopy face'],
    ['Beagle (13 Inch)', 'Beagle', 'Snoopy\'s breed, the smaller size'],
    ['Beagle (15 Inch)', 'Beagle', 'Snoopy\'s breed, the larger size'],
    ['Black and Tan Coonhound', '', 'Big, long-eared black-and-tan hunter'],
    ['Bloodhound', '', 'Wrinkly super-sniffer with huge ears'],
    ['Bluetick Coonhound', '', 'Blue-speckled Southern raccoon hound'],
    ['Borzoi', '', 'Tall, silky Russian wolfhound'],
    ['Cirneco dell\'Etna', '', 'Small, fawn Sicilian hound with big ears'],
    ['Dachshund (Longhaired)', 'Dachshund', 'Wiener dog with long flowing hair'],
    ['Dachshund (Smooth)', 'Dachshund', 'Classic short-haired wiener dog'],
    ['Dachshund (Wirehaired)', 'Dachshund', 'Wiener dog with a scruffy beard'],
    ['English Foxhound', '', 'Sturdy tri-color English pack hound'],
    ['Grand Basset Griffon Vendeen', 'Grand Basset Griffon Vendéen', 'Shaggy, longer-legged French basset'],
    ['Greyhound', '', 'The racing dog, built for speed'],
    ['Harrier', 'Harrier (dog)', 'Mid-sized pack hound, a big Beagle'],
    ['Ibizan Hound', '', 'Tall red-and-white hound with huge ears'],
    ['Irish Wolfhound', '', 'The tallest breed, a gentle giant'],
    ['Norwegian Elkhound', '', 'Gray, curly-tailed Viking hunting dog'],
    ['Otterhound', '', 'Big, shaggy, rare otter hunter'],
    ['Petit Basset Griffon Vendeen', 'Petit Basset Griffon Vendéen', 'Small, shaggy, happy French hound'],
    ['Pharaoh Hound', '', 'Sleek red hound that "blushes"'],
    ['Plott Hound', 'Plott Hound', 'Brindle bear-hunting hound'],
    ['Portuguese Podengo Pequeno', '', 'Tiny, alert Portuguese rabbit hound'],
    ['Redbone Coonhound', '', 'Solid red Southern coonhound'],
    ['Rhodesian Ridgeback', '', 'Athletic hound with a ridge on its back'],
    ['Saluki', '', 'Ancient, elegant Middle Eastern sighthound'],
    ['Scottish Deerhound', '', 'Tall, wiry, gray Scottish sighthound'],
    ['Sloughi', '', 'Slim, short-haired North African sighthound'],
    ['Treeing Walker Coonhound', '', 'Tri-color treeing coonhound'],
    ['Whippet', '', 'Mini greyhound, a fast couch potato'],
  ],
  working: [
    ['Akita', 'Akita (dog)', 'Powerful, bear-like Japanese guardian'],
    ['Alaskan Malamute', '', 'Big, fluffy Arctic sled hauler'],
    ['Anatolian Shepherd Dog', '', 'Huge Turkish livestock guardian'],
    ['Bernese Mountain Dog', '', 'Big tri-color Swiss farm dog'],
    ['Black Russian Terrier', '', 'Huge, shaggy black guard dog'],
    ['Boerboel', '', 'Massive South African mastiff'],
    ['Boxer', 'Boxer (dog)', 'Bouncy, square-jawed family dog'],
    ['Bullmastiff', '', 'Big, quiet estate guardian'],
    ['Cane Corso', '', 'Muscular Italian mastiff'],
    ['Chinook', 'Chinook (dog)', 'Tawny New Hampshire sled dog'],
    ['Danish-Swedish Farmdog', '', 'Small, spotted farm dog'],
    ['Doberman Pinscher', '', 'Sleek black-and-rust guard dog'],
    ['Dogo Argentino', '', 'Big, all-white Argentine hunter'],
    ['Dogue de Bordeaux', '', 'Wrinkly red French mastiff'],
    ['German Pinscher', '', 'Medium, sleek, alert German dog'],
    ['Giant Schnauzer', '', 'Big, bearded, black working dog'],
    ['Great Dane', '', 'Scooby-Doo\'s breed, extremely tall'],
    ['Great Pyrenees', '', 'Big, fluffy white mountain guardian'],
    ['Greater Swiss Mountain Dog', '', 'Short-haired, tri-color Swiss giant'],
    ['Komondor', '', 'Covered in white rope-like cords'],
    ['Kuvasz', '', 'Large white Hungarian guardian'],
    ['Leonberger', '', 'Lion-like, fluffy German giant'],
    ['Mastiff', 'English Mastiff', 'One of the heaviest breeds, very calm'],
    ['Neapolitan Mastiff', '', 'Giant, very wrinkly Italian mastiff'],
    ['Newfoundland', 'Newfoundland dog', 'Giant, sweet water-rescue dog'],
    ['Portuguese Water Dog', '', 'Curly fisherman\'s helper (the Obama dog)'],
    ['Rottweiler', '', 'Strong black-and-tan German guardian'],
    ['Saint Bernard', 'St. Bernard (dog)', 'Giant Alpine rescue dog'],
    ['Samoyed', 'Samoyed dog', 'Fluffy white dog with a built-in smile'],
    ['Siberian Husky', '', 'Blue-eyed sled dog'],
    ['Standard Schnauzer', '', 'Medium, bearded German farm dog'],
    ['Tibetan Mastiff', '', 'Huge, maned Himalayan guardian'],
  ],
  terrier: [
    ['Airedale Terrier', '', 'The largest terrier, the "King of Terriers"'],
    ['American Hairless Terrier', '', 'Small, hairless American terrier'],
    ['American Staffordshire Terrier', '', 'Muscular, friendly "AmStaff"'],
    ['Australian Terrier', '', 'Small, scruffy Aussie ratter'],
    ['Bedlington Terrier', '', 'Looks like a little lamb'],
    ['Border Terrier', '', 'Scrappy, otter-headed farm terrier'],
    ['Bull Terrier (Colored)', 'Bull Terrier', 'Egg-shaped head, any color but white'],
    ['Bull Terrier (White)', 'Bull Terrier', 'Egg-shaped head, white (the Target dog)'],
    ['Cairn Terrier', '', 'Toto from The Wizard of Oz'],
    ['Cesky Terrier', 'Český Terrier', 'Silky gray Czech terrier'],
    ['Dandie Dinmont Terrier', '', 'Long, low, with a fluffy topknot'],
    ['Glen of Imaal Terrier', '', 'Sturdy, quiet Irish terrier'],
    ['Irish Terrier', '', 'Red, bold Irish daredevil'],
    ['Kerry Blue Terrier', '', 'Soft, wavy blue-gray coat'],
    ['Lakeland Terrier', '', 'Small, confident English terrier'],
    ['Manchester Terrier (Standard)', 'Manchester Terrier', 'Sleek black-and-tan ratter'],
    ['Miniature Bull Terrier', '', 'Smaller version of the egg-headed Bull Terrier'],
    ['Miniature Schnauzer', '', 'Small, bearded, eyebrowed terrier'],
    ['Norfolk Terrier', '', 'Tiny terrier with folded ears'],
    ['Norwich Terrier', '', 'Tiny terrier with prick ears'],
    ['Parson Russell Terrier', '', 'Leggy Jack Russell type'],
    ['Rat Terrier', '', 'Spotted American farm ratter'],
    ['Russell Terrier', '', 'Short-legged Jack Russell type'],
    ['Scottish Terrier', '', 'The black "Scottie" (Monopoly piece)'],
    ['Sealyham Terrier', '', 'White, bearded Welsh terrier'],
    ['Skye Terrier', '', 'Long, low, with long hair over its eyes'],
    ['Smooth Fox Terrier', '', 'Short-haired, mostly white fox terrier'],
    ['Soft Coated Wheaten Terrier', '', 'Silky, wheat-colored Irish terrier'],
    ['Staffordshire Bull Terrier', '', 'Compact, muscular, people-loving "Staffy"'],
    ['Teddy Roosevelt Terrier', '', 'Short-legged American ratter (new in 2026)'],
    ['Welsh Terrier', '', 'Mini Airedale look-alike'],
    ['West Highland White Terrier', '', 'The white "Westie"'],
    ['Wire Fox Terrier', '', 'Wiry white terrier, a frequent winner'],
  ],
  toy: [
    ['Affenpinscher', '', 'The "monkey dog" with a scruffy face'],
    ['Biewer Terrier', '', 'Tri-color, Yorkie-like long-haired toy'],
    ['Brussels Griffon', '', 'Small dog with a very human face'],
    ['Cavalier King Charles Spaniel', '', 'Sweet, big-eyed, silky toy spaniel'],
    ['Chihuahua (Long Coat)', 'Chihuahua (dog)', 'The tiniest breed, with long fur'],
    ['Chihuahua (Smooth Coat)', 'Chihuahua (dog)', 'The tiniest breed, short-haired'],
    ['Chinese Crested', 'Chinese Crested Dog', 'Mostly hairless with a fluffy head'],
    ['English Toy Spaniel (B&PC)', 'King Charles Spaniel', 'Flat-faced toy spaniel, Blenheim or tri-color'],
    ['English Toy Spaniel (KC&R)', 'King Charles Spaniel', 'Flat-faced toy spaniel, black-tan or ruby'],
    ['Havanese', '', 'Cuban fluffball, cheerful and silky'],
    ['Italian Greyhound', '', 'A miniature, delicate greyhound'],
    ['Japanese Chin', '', 'Flat-faced, catlike Japanese lapdog'],
    ['Maltese', 'Maltese dog', 'Floor-length white silky coat'],
    ['Manchester Terrier (Toy)', 'Manchester Terrier', 'Mini sleek black-and-tan terrier'],
    ['Miniature Pinscher', '', 'Tiny, high-stepping "King of Toys"'],
    ['Papillon', 'Papillon dog', 'Toy dog with butterfly-wing ears'],
    ['Pekingese', '', 'Lion-maned Chinese palace dog'],
    ['Pomeranian', 'Pomeranian dog', 'Tiny, very fluffy, fox-faced puffball'],
    ['Poodle (Toy)', 'Poodle', 'The smallest poodle size'],
    ['Pug', '', 'Wrinkly, flat-faced, curly-tailed clown'],
    ['Russian Toy', '', 'Tiny, leggy Russian toy with fringed ears'],
    ['Russian Tsvetnaya Bolonka', '', 'Fluffy colored Russian lapdog (new in 2026)'],
    ['Shih Tzu', '', 'Long-haired Chinese "lion dog"'],
    ['Silky Terrier', '', 'Yorkie-like Australian toy terrier'],
    ['Toy Fox Terrier', '', 'Tiny, mostly white, spunky terrier'],
    ['Yorkshire Terrier', '', 'The "Yorkie," long steel-blue and tan coat'],
  ],
  'non-sporting': [
    ['American Eskimo Dog', '', 'Fluffy white spitz, former circus dog'],
    ['Bichon Frise', '', 'White powder-puff cloud of a dog'],
    ['Boston Terrier', '', 'The tuxedoed "American Gentleman"'],
    ['Bulldog', 'Bulldog', 'Wrinkly, pushed-in face, sturdy and low'],
    ['Chinese Shar-Pei', 'Shar Pei', 'Very wrinkly with a blue-black tongue'],
    ['Chow Chow', '', 'Lion-like mane and a blue-black tongue'],
    ['Coton de Tulear', '', 'Cotton-soft white dog from Madagascar'],
    ['Dalmatian', 'Dalmatian dog', 'The spotted firehouse dog'],
    ['Finnish Spitz', '', 'Red, foxlike Finnish "barking bird dog"'],
    ['French Bulldog', '', 'Bat-eared, popular little bulldog'],
    ['Keeshond', '', 'Fluffy gray dog with "spectacles"'],
    ['Lhasa Apso', '', 'Long-haired Tibetan monastery sentinel'],
    ['Lowchen', 'Löwchen', 'Small "lion dog" with a lion-style trim'],
    ['Norwegian Lundehund', '', 'Puffin-hunting dog with six toes'],
    ['Poodle (Miniature)', 'Poodle', 'The middle poodle size'],
    ['Poodle (Standard)', 'Poodle', 'The large, elegant poodle'],
    ['Schipperke', '', 'Small, black, tailless "little captain"'],
    ['Shiba Inu', '', 'Foxy Japanese dog (the "doge" meme)'],
    ['Tibetan Spaniel', '', 'Small, silky Tibetan watchdog'],
    ['Tibetan Terrier', '', 'Shaggy, snowshoe-footed Tibetan dog'],
    ['Xoloitzcuintli', '', 'Ancient Mexican hairless dog (from Coco)'],
  ],
  herding: [
    ['Australian Cattle Dog', '', 'Tough "Blue Heeler" cattle dog'],
    ['Australian Shepherd', '', 'Merle-coated, often blue-eyed herder'],
    ['Bearded Collie', '', 'Shaggy, bouncy, bearded herder'],
    ['Beauceron', '', 'Big black-and-tan French herder'],
    ['Belgian Laekenois', '', 'Rough-coated, rarest Belgian shepherd'],
    ['Belgian Malinois', '', 'Police and military dog, fawn with black mask'],
    ['Belgian Sheepdog', 'Groenendael dog', 'Long-haired, all-black Belgian (2025 Best in Show)'],
    ['Belgian Tervuren', '', 'Long-haired fawn Belgian shepherd'],
    ['Bergamasco Sheepdog', 'Bergamasco Shepherd', 'Coat grows into flat felted mats'],
    ['Berger Picard', '', 'Scruffy French herder (from "Because of Winn-Dixie")'],
    ['Border Collie', '', 'The smartest breed, sheep-herding star'],
    ['Bouvier des Flandres', '', 'Big, bearded Belgian cattle dog'],
    ['Briard', '', 'Big, shaggy French herder'],
    ['Canaan Dog', '', 'Israel\'s national dog, alert and agile'],
    ['Cardigan Welsh Corgi', '', 'Corgi with a long fox-like tail'],
    ['Collie (Rough)', 'Rough Collie', 'Lassie\'s breed, long coat'],
    ['Collie (Smooth)', 'Smooth Collie', 'Lassie\'s breed with a short coat'],
    ['Entlebucher Mountain Dog', '', 'Smallest of the Swiss mountain dogs'],
    ['Finnish Lapphund', '', 'Fluffy reindeer herder from Lapland'],
    ['German Shepherd Dog', '', 'The classic police dog'],
    ['Icelandic Sheepdog', '', 'Fluffy, curly-tailed Viking herder'],
    ['Lancashire Heeler', '', 'Small black-and-tan "smiling" heeler'],
    ['Miniature American Shepherd', '', 'Smaller version of the Aussie Shepherd'],
    ['Mudi', 'Mudi (dog)', 'Wavy-coated Hungarian farm dog'],
    ['Norwegian Buhund', '', 'Curly-tailed Norwegian farm dog'],
    ['Old English Sheepdog', '', 'Big, shaggy gray-and-white herder'],
    ['Pembroke Welsh Corgi', '', 'The Queen\'s corgi, no tail'],
    ['Polish Lowland Sheepdog', '', 'Shaggy, medium Polish herder'],
    ['Puli', 'Puli (dog)', 'Covered in black dreadlock cords'],
    ['Pumi', 'Pumi (dog)', 'Curly Hungarian herder with whimsical ears'],
    ['Pyrenean Shepherd', '', 'Small, lively French mountain herder'],
    ['Shetland Sheepdog', '', 'The "Sheltie," a mini Lassie'],
    ['Spanish Water Dog', '', 'Curly, woolly Spanish herder'],
    ['Swedish Vallhund', '', 'Corgi-like Viking cattle dog'],
  ],
};

/**
 * Turn a display name into a URL-safe, stable id.
 * "Cocker Spaniel (ASCOB)" -> "cocker-spaniel-ascob"
 */
export function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Flat list of breeds: { id, name, group, wiki, blurb } */
export const BREEDS = GROUPS.flatMap((g) =>
  RAW[g.key].map(([name, wiki, blurb]) => ({
    id: slugify(name),
    name,
    group: g.key,
    wiki: wiki || name,
    blurb,
  })),
);

/** Fast lookup by id. */
export const BREED_BY_ID = new Map(BREEDS.map((b) => [b.id, b]));

export const GROUP_KEYS = GROUPS.map((g) => g.key);

// Fail fast at import time if the catalog is ever edited into a bad state
// (duplicate ids would silently merge picks for two different breeds).
if (BREED_BY_ID.size !== BREEDS.length) {
  throw new Error('breeds.js: duplicate breed ids detected');
}
